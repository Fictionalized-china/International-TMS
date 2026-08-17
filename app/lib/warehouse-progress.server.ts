import { env } from "cloudflare:workers";
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
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
           started_at=COALESCE(started_at,?),completed_at=?,blocking_reason=NULL,updated_at=?
       WHERE id=?`,
    ).bind(
      completed ? "completed" : "in_progress",
      input.stepCode,
      input.stepName,
      nextRank,
      now,
      completed ? now : null,
      now,
      module.id,
    ),
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
  const orders = await env.DB.prepare(
    `SELECT order_id
     FROM transport_batch_orders
     WHERE organization_id=? AND batch_id=? AND status!='removed'
     ORDER BY sequence_no,created_at`,
  )
    .bind(input.organizationId, input.batchId)
    .all<{ order_id: string }>();
  if (!orders.results.length) return 0;

  // Module rows must exist before building the single atomic update batch.
  await Promise.all(
    orders.results.map((item) => ensureOrderModules(input.organizationId, item.order_id)),
  );
  const placeholders = orders.results.map(() => "?").join(",");
  const modules = await env.DB.prepare(
    `SELECT id,order_id,current_step_code
     FROM order_module_instances
     WHERE organization_id=? AND module_code='loading' AND enabled=1
       AND order_id IN (${placeholders})`,
  )
    .bind(input.organizationId, ...orders.results.map((item) => item.order_id))
    .all<{ id: string; order_id: string; current_step_code: string | null }>();
  if (modules.results.length !== orders.results.length) {
    throw new Error("配载批次订单模块不完整，已停止整批推进；请刷新订单模块后重试");
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const module of modules.results) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='completed',current_step_code='confirmed',current_step_name='装车出库交接完成',
             progress_percent=100,started_at=COALESCE(started_at,?),completed_at=?,
             blocking_reason=NULL,updated_at=?
         WHERE id=?`,
      ).bind(now, now, now, module.id),
    );
    if (module.current_step_code !== "confirmed") {
      statements.push(
        env.DB.prepare(
          `INSERT INTO order_module_history(
            id,organization_id,order_id,module_instance_id,action_code,action_name,
            from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
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
        ),
      );
    }
  }
  await env.DB.batch(statements);

  await Promise.all(
    orders.results.map((item) => syncOrderWorkflowSnapshot(input.organizationId, item.order_id)),
  );
  return orders.results.length;
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
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
           started_at=COALESCE(started_at,?),completed_at=?,blocking_reason=NULL,updated_at=?
       WHERE id=?`,
    ).bind(
      completed ? "completed" : "in_progress",
      mappedStepCode,
      mappedStepName,
      loadingStepRank[input.stepCode],
      now,
      completed ? now : null,
      now,
      module.id,
    ),
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
