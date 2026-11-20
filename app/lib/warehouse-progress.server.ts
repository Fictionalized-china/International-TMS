import { env } from "cloudflare:workers";
import {prepareOrderIntakeAdvance,prepareBatchIntakeAdvance,intakeGateCommitStatements,intakeManyCommitStatements} from "./order-intake-gate.server";
import {changedRowGuard,predicateGuard} from "./mutation-guard.server";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "./d1-bindings";
import {
  ensureOrderModules,
  syncOrderWorkflowSnapshot,
} from "./order-modules.server";

const warehouseStepRank = {
  waiting: 0,
  receiving: 50,
  ready: 100,
} as const;

const loadingStepRank = {
  loading: 75,
  outbound: 100,
} as const;

export async function recordWarehouseProgress(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  stepCode: keyof typeof warehouseStepRank | keyof typeof loadingStepRank;
  stepName: string;
  actionCode: string;
  actionName: string;
  notes?: string;
}) {
  await ensureOrderModules(input.organizationId, input.orderId);
  const stepCode = input.stepCode;
  if (stepCode === "loading" || stepCode === "outbound") {
    await recordLoadingProgress({ ...input, stepCode });
    return;
  }
  const module = await env.DB.prepare(
    `SELECT id,enabled,status,current_step_code
     FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND module_code='warehouse'`,
  )
    .bind(input.organizationId, input.orderId)
    .first<{
      id: string;
      enabled: number;
      status: string;
      current_step_code: string | null;
    }>();
  if (!module?.enabled) return;

  const currentStepCode = module.current_step_code as keyof typeof warehouseStepRank | null;
  const currentRank = currentStepCode && currentStepCode in warehouseStepRank
    ? warehouseStepRank[currentStepCode]
    : 0;
  const nextRank = warehouseStepRank[stepCode];
  if (nextRank < currentRank || module.status === "completed") return;

  const now = new Date().toISOString();
  const completed = input.stepCode === "ready";
  const statements: D1PreparedStatement[] = [
    ...intakeGateCommitStatements(await prepareOrderIntakeAdvance(input.organizationId,input.orderId),now),
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
           started_at=COALESCE(started_at,?),completed_at=?,blocking_reason=NULL,updated_at=?
       WHERE id=? AND status=? AND COALESCE(current_step_code,'')=?`,
    ).bind(
      completed ? "completed" : "in_progress",
      input.stepCode,
      input.stepName,
      nextRank,
      now,
      completed ? now : null,
      now,
      module.id,
      module.status,module.current_step_code??'',
    ),
    changedRowGuard(env.DB,now),
  ];
  if (module.current_step_code !== input.stepCode) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_module_history(
          id,organization_id,order_id,module_instance_id,action_code,action_name,
          from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        input.orderId,
        module.id,
        input.actionCode,
        input.actionName,
        module.current_step_code,
        input.stepCode,
        input.stepName,
        input.actorUserId,
        input.notes ?? null,
        now,
      ),
    );
  }
  await env.DB.batch(statements);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
}

export async function recordBatchOutboundProgress(input: {
  organizationId: string;
  batchId: string;
  actorUserId: string;
  dispatchNumber: string;
  referenceOrderId?: string;
}) {
  const intakeSnapshots=await prepareBatchIntakeAdvance(input.organizationId,input.batchId);
  const orders = await env.DB.prepare(
    `SELECT order_id
     FROM transport_batch_orders
     WHERE organization_id=? AND batch_id=? AND status!='removed'
     ORDER BY sequence_no,created_at`,
  )
    .bind(input.organizationId, input.batchId)
    .all<{ order_id: string }>();
  if (!orders.results.length) return 0;
  const orderIds = [...new Set(orders.results.map((item) => item.order_id))];

  // Avoid opening one D1 connection per order. Module creation is intentionally
  // sequential; the following reads and writes are bounded independently.
  for (const orderId of orderIds)
    await ensureOrderModules(input.organizationId, orderId);

  const modules: Array<{
    id: string;
    order_id: string;
    status:string;
    current_step_code: string | null;
  }> = [];
  for (const chunk of chunkD1Values(orderIds, 1)) {
    const rows = await env.DB.prepare(
      `SELECT id,order_id,status,current_step_code
       FROM order_module_instances
       WHERE organization_id=? AND module_code='loading' AND enabled=1
         AND order_id IN (${d1Placeholders(chunk.length)})`,
    )
      .bind(input.organizationId, ...chunk)
      .all<{ id: string; order_id: string; status:string; current_step_code: string | null }>();
    modules.push(...rows.results);
  }
  if (modules.length !== orderIds.length) {
    throw new Error("配载批次订单模块不完整，已停止整批推进；请刷新订单模块后重试");
  }

  const pendingOrderIds=new Set<string>();
  for(const orderChunk of chunkD1Values(orderIds,2)){
    const rows=await env.DB.prepare(`SELECT job.order_id
      FROM warehouse_packing_jobs job
      JOIN warehouse_packages package_row ON package_row.packing_job_id=job.id
        AND package_row.organization_id=job.organization_id
        AND package_row.label_kind='oul' AND package_row.lifecycle_status='active'
        AND package_row.status!='dispatched'
      WHERE job.organization_id=? AND job.order_id IN (${d1Placeholders(orderChunk.length)})
        AND job.status!='cancelled'
      GROUP BY job.order_id`)
      .bind(input.organizationId,...orderChunk).all<{order_id:string}>();
    rows.results.forEach(row=>pendingOrderIds.add(row.order_id));
  }
  const completedModules=modules.filter(module=>!pendingOrderIds.has(module.order_id));
  const partialModules=modules.filter(module=>pendingOrderIds.has(module.order_id)&&module.status!=="completed");

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    ...intakeManyCommitStatements(intakeSnapshots,now),
    ...modules.map(module=>predicateGuard(env.DB,"EXISTS(SELECT 1 FROM order_module_instances WHERE id=? AND organization_id=? AND order_id=? AND enabled=1 AND status=? AND COALESCE(current_step_code,'')=?)",[module.id,input.organizationId,module.order_id,module.status,module.current_step_code??''],now)),
  ];
  for (const moduleChunk of chunkD1Values(completedModules, 3)) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='completed',current_step_code='confirmed',current_step_name='装车出库交接完成',
             progress_percent=100,started_at=COALESCE(started_at,?),completed_at=?,
             blocking_reason=NULL,updated_at=?
         WHERE id IN (${d1Placeholders(moduleChunk.length)})`,
      ).bind(now, now, now, ...moduleChunk.map((module) => module.id)),
    );
  }
  for(const moduleChunk of chunkD1Values(partialModules,3)){
    statements.push(env.DB.prepare(`UPDATE order_module_instances
      SET status='in_progress',current_step_code='loading',current_step_name='分批装车出库中',
          progress_percent=80,started_at=COALESCE(started_at,?),completed_at=NULL,
          blocking_reason='同一订单仍有其他 OUL 待配载或待出库',updated_at=?
      WHERE id IN (${d1Placeholders(moduleChunk.length)}) AND status!='completed'`)
      .bind(now,now,...moduleChunk.map(module=>module.id)));
  }
  const historyModules = completedModules.filter((module) => module.current_step_code !== "confirmed");
  for (const moduleChunk of chunkD1Rows(historyModules, 12)) {
    statements.push(env.DB.prepare(
      `INSERT INTO order_module_history(
        id,organization_id,order_id,module_instance_id,action_code,action_name,
        from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
      ) VALUES ${moduleChunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`,
    ).bind(...moduleChunk.flatMap((module) => [
      crypto.randomUUID(),
      input.organizationId,
      module.order_id,
      module.id,
      module.order_id === input.referenceOrderId ? "dispatch_complete" : "dispatch_complete_synced",
      module.order_id === input.referenceOrderId ? "完成装车出库交接" : "同配载单装车出库同步",
      module.current_step_code,
      "confirmed",
      "装车出库交接完成",
      input.actorUserId,
      `同一配载单随装车任务 ${input.dispatchNumber} 完成装车出库，等待出境确认`,
      now,
    ])));
  }
  const partialHistory=partialModules.filter(module=>module.current_step_code!=="loading");
  for(const moduleChunk of chunkD1Rows(partialHistory,12)){
    statements.push(env.DB.prepare(`INSERT INTO order_module_history(
      id,organization_id,order_id,module_instance_id,action_code,action_name,
      from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
    ) VALUES ${moduleChunk.map(()=>"(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`)
      .bind(...moduleChunk.flatMap(module=>[
        crypto.randomUUID(),input.organizationId,module.order_id,module.id,
        "partial_dispatch_complete","完成本批装车出库",module.current_step_code,
        "loading","分批装车出库中",input.actorUserId,
        `配载单随装车任务 ${input.dispatchNumber} 完成本批出库；订单仍有其他 OUL 待发`,now,
      ])));
  }
  await env.DB.batch(statements);

  for (const orderId of orderIds)
    await syncOrderWorkflowSnapshot(input.organizationId, orderId);
  return orderIds.length;
}

async function recordLoadingProgress(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  stepCode: "loading" | "outbound";
  stepName: string;
  actionCode: string;
  actionName: string;
  notes?: string;
}) {
  const module = await env.DB.prepare(
    `SELECT id,enabled,status,current_step_code
     FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND module_code='loading'`,
  )
    .bind(input.organizationId, input.orderId)
    .first<{ id: string; enabled: number; status: string; current_step_code: string | null }>();
  if (!module?.enabled || module.status === "completed") return;

  const now = new Date().toISOString();
  const completed = input.stepCode === "outbound";
  const mappedStepCode = completed ? "confirmed" : "loading";
  const mappedStepName = completed ? "装车出库交接完成" : "拣货装车";
  const statements: D1PreparedStatement[] = [
    ...intakeGateCommitStatements(await prepareOrderIntakeAdvance(input.organizationId,input.orderId),now),
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
           started_at=COALESCE(started_at,?),completed_at=?,blocking_reason=NULL,updated_at=?
       WHERE id=? AND status=? AND COALESCE(current_step_code,'')=?`,
    ).bind(
      completed ? "completed" : "in_progress",
      mappedStepCode,
      mappedStepName,
      loadingStepRank[input.stepCode],
      now,
      completed ? now : null,
      now,
      module.id,
      module.status,module.current_step_code??'',
    ),
    changedRowGuard(env.DB,now),
  ];
  if (module.current_step_code !== mappedStepCode) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_module_history(
          id,organization_id,order_id,module_instance_id,action_code,action_name,
          from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(), input.organizationId, input.orderId, module.id,
        input.actionCode, input.actionName, module.current_step_code,
        mappedStepCode, mappedStepName, input.actorUserId, input.notes ?? null, now,
      ),
    );
  }
  await env.DB.batch(statements);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
}
