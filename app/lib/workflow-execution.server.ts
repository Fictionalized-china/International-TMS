import { env } from "cloudflare:workers";
import {
  isRetryableMysqlTransactionError,
  mysqlTransactionRetryDelayMs,
} from "../runtime/mysql-transaction-policy";
import {
  createOrderWorkflowFieldReader,
  snapshotWorkflowFieldsForInstance,
} from "./workflow-fields.server";
import { loadWorkflowPlacementBlockers } from "./workflow-field-read-batch";
import { workflowModuleStateStatements, workflowStepStateStatements, type WorkflowStateWrite } from "./workflow-state-write-batch";
import { workflowVersionSwitchDecision } from "./workflow-version-policy";
import {
  selectWorkflowExecutionCurrentStep,
  workflowExecutionModuleIsComplete,
  workflowSystemTaskHasAutoHandler,
  workflowSystemTaskShouldAutoComplete,
} from "./workflow-execution";
import { canCompleteWorkflowTask } from "./workflow-task-access";
import { withOrderProjectionSync } from "./order-sync-queue.server";
import { activePositionProfilePredicate, loadActivePositionAccessProfile } from "./position-access-profile.server";
import { changedRowGuard, guardedBatch, predicateGuard } from "./mutation-guard.server";

type ModuleFact = { module_code:string; status:string };

// Snapshot statements are idempotent (INSERT OR IGNORE + guarded UPDATEs), so
// the whole block is safe to retry when MySQL reports a transient deadlock.
// These statements run as autocommit .run() calls outside the adapter's
// transaction retry policy, so a retry loop must be applied here explicitly.
const SNAPSHOT_DEADLOCK_RETRY_ATTEMPTS = 3;

async function runSnapshotStatement(statement:()=>Promise<unknown>) {
  let lastError:unknown;
  for (let attempt=0; attempt<=SNAPSHOT_DEADLOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await statement();
    } catch (error) {
      lastError = error;
      if (attempt>=SNAPSHOT_DEADLOCK_RETRY_ATTEMPTS
        || !isRetryableMysqlTransactionError(error)) throw error;
      await new Promise((resolve)=>setTimeout(resolve,mysqlTransactionRetryDelayMs(attempt)));
    }
  }
  throw lastError;
}

export async function ensureWorkflowExecutionSnapshot(input:{
  instanceId:string;
  workflowId:string;
}) {
  const now = new Date().toISOString();
  await runSnapshotStatement(() => env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_instance_step_states(
      id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at
     )
     SELECT lower(hex(randomblob(16))),?,?,s.id,s.step_key,s.name,s.sort_order,'pending',?
     FROM workflow_steps s WHERE s.workflow_id=? AND s.is_active=1`,
  ).bind(input.instanceId,input.workflowId,now,input.workflowId).run());
  await runSnapshotStatement(() => env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_instance_module_states(
      id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,status,
      responsibility_position_code,completion_mode,updated_at
     )
     SELECT lower(hex(randomblob(16))),ss.id,m.id,m.module_code,m.display_name,m.sort_order,m.is_required,'pending',
       m.responsibility_position_code,m.completion_mode,?
     FROM workflow_instance_step_states ss JOIN workflow_step_modules m
       ON m.workflow_id=ss.workflow_id AND m.step_id=ss.step_id AND m.is_active=1
     WHERE ss.instance_id=?`,
  ).bind(now,input.instanceId).run());
  await runSnapshotStatement(() => env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_instance_task_states(
      id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,is_required,status,
      responsibility_position_code,instructions,updated_at
     )
     SELECT lower(hex(randomblob(16))),ms.id,t.id,t.task_key,t.name,t.task_type,t.sort_order,t.is_required,'pending',
       COALESCE(t.responsibility_position_code,ms.responsibility_position_code),t.instructions,?
     FROM workflow_instance_module_states ms
     JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
     JOIN workflow_module_tasks t ON t.workflow_id=ss.workflow_id AND t.step_module_id=ms.step_module_id AND t.is_active=1
     WHERE ss.instance_id=?`,
  ).bind(now,input.instanceId).run());
  await runSnapshotStatement(() => env.DB.prepare(
    `UPDATE workflow_instance_step_states
     SET status='active',started_at=COALESCE(started_at,?),updated_at=?
     WHERE instance_id=? AND step_key=(
       SELECT current_step_key FROM workflow_instances WHERE id=?
     ) AND status='pending'`,
  ).bind(now,now,input.instanceId,input.instanceId).run());
  await runSnapshotStatement(() => env.DB.prepare(
    `UPDATE workflow_instance_module_states
     SET status='active',updated_at=?
     WHERE instance_step_state_id IN (
       SELECT id FROM workflow_instance_step_states WHERE instance_id=? AND status='active'
     ) AND status='pending'`,
  ).bind(now,input.instanceId).run());
  await runSnapshotStatement(() => env.DB.prepare(
    `UPDATE workflow_instance_task_states
     SET status='active',updated_at=?
     WHERE instance_module_state_id IN (
       SELECT ms.id FROM workflow_instance_module_states ms
       JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
       WHERE ss.instance_id=? AND ss.status='active'
     ) AND status='pending'`,
  ).bind(now,input.instanceId).run());
}

export async function synchronizeWorkflowExecution(input:{
  organizationId:string;
  orderId:string;
  instanceId:string;
  workflowId:string;
  targetStepKey:string;
  orderStatus:string;
}) {
  // Only projection writes share a queue. Do not serialize the subsequent
  // permission/business fact reads or reuse another caller's calculations.
  await withOrderProjectionSync(input.organizationId,input.orderId,()=>ensureWorkflowExecutionSnapshot({instanceId:input.instanceId,workflowId:input.workflowId}));
  const [target,moduleFacts,rows] = await Promise.all([
    env.DB.prepare(
      "SELECT sort_order FROM workflow_steps WHERE workflow_id=? AND step_key=? AND is_active=1",
    ).bind(input.workflowId,input.targetStepKey).first<{sort_order:number}>(),
    env.DB.prepare(
      "SELECT module_code,status FROM order_module_instances WHERE organization_id=? AND order_id=?",
    ).bind(input.organizationId,input.orderId).all<ModuleFact>(),
    env.DB.prepare(
      `SELECT ss.id step_state_id,ss.step_key,ss.sort_order,ms.id module_state_id,ms.module_code,
        ms.is_required module_required,ms.completion_mode,ts.id task_state_id,ts.task_key,
        ts.task_type,ts.is_required task_required,ts.status task_status
       FROM workflow_instance_step_states ss
       LEFT JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
       LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
       WHERE ss.instance_id=? ORDER BY ss.sort_order,ms.sort_order,ts.sort_order`,
    ).bind(input.instanceId).all<{
      step_state_id:string;step_key:string;sort_order:number;module_state_id:string|null;
      module_code:string|null;module_required:number|null;completion_mode:string|null;
      task_state_id:string|null;task_key:string|null;task_type:string|null;
      task_required:number|null;task_status:string|null;
    }>(),
  ]);
  if (!target) return input.targetStepKey;
  const now = new Date().toISOString();
  if (input.orderStatus === "completed") {
    await withOrderProjectionSync(input.organizationId,input.orderId,()=>env.DB.batch([
      env.DB.prepare(
        `UPDATE workflow_instance_task_states
            SET status='completed',completed_at=COALESCE(completed_at,?),updated_at=?
          WHERE instance_module_state_id IN (
            SELECT ms.id FROM workflow_instance_module_states ms
            JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
            WHERE ss.instance_id=?
          )`,
      ).bind(now,now,input.instanceId),
      env.DB.prepare(
        `UPDATE workflow_instance_module_states
            SET status='completed',updated_at=?
          WHERE instance_step_state_id IN (
            SELECT id FROM workflow_instance_step_states WHERE instance_id=?
          )`,
      ).bind(now,input.instanceId),
      env.DB.prepare(
        `UPDATE workflow_instance_step_states
            SET status='completed',started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),updated_at=?
          WHERE instance_id=?`,
      ).bind(now,now,now,input.instanceId),
      env.DB.prepare(
        `UPDATE workflow_instances
            SET current_step_key=?,status='completed',completed_at=COALESCE(completed_at,?),updated_at=?
          WHERE id=? AND organization_id=?`,
      ).bind(input.targetStepKey,now,now,input.instanceId,input.organizationId),
    ]));
    return input.targetStepKey;
  }
  const moduleStatus = new Map(moduleFacts.results.map((item)=>[item.module_code,item.status]));
  const taskUpdates: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    if (!row.task_state_id || row.task_status === "completed") continue;
    const autoComplete = workflowSystemTaskShouldAutoComplete(
      row.step_key,row.task_key || "",input.orderStatus,moduleStatus.get(row.module_code || "") || "not_started",
    );
    if (autoComplete) {
      taskUpdates.push(env.DB.prepare(
        `UPDATE workflow_instance_task_states SET status='completed',completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=?`,
      ).bind(now,now,row.task_state_id));
    }
  }
  if (taskUpdates.length) await withOrderProjectionSync(input.organizationId,input.orderId,()=>env.DB.batch(taskUpdates));

  const modules = await env.DB.prepare(
    `SELECT ms.id,ms.instance_step_state_id,ms.is_required,ms.completion_mode,ms.module_code,ss.step_key,ss.sort_order step_sort_order,
      ss.status step_status,
      COUNT(ts.id) task_count,
      SUM(CASE WHEN ts.is_required=1 AND ts.status!='completed' THEN 1 ELSE 0 END) pending_required
     FROM workflow_instance_module_states ms
     LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
     JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
     WHERE ss.instance_id=? GROUP BY ms.id`,
  ).bind(input.instanceId).all<{
    id:string;instance_step_state_id:string;is_required:number;completion_mode:string;
    module_code:string;step_key:string;step_sort_order:number;step_status:string;
    task_count:number;pending_required:number;
  }>();
  // This phase has no writes: reuse each module's full frozen field snapshot,
  // but still evaluate every placement's own required fields independently.
  const fieldBlockers = await loadWorkflowPlacementBlockers(
    modules.results,
    createOrderWorkflowFieldReader(input.organizationId, input.orderId),
  );
  // A completed signature task is not evidence of settled funds. Keep the final
  // required costs placement open even when its cash fields are optional.
  // Passed business nodes remain historical; only unfinished settlement is gated.
  const lastRequiredCostsSort = Math.max(-Infinity, ...modules.results.filter(item => item.module_code === "costs" && item.is_required === 1).map(item => item.step_sort_order));
  const unsettledCosts = modules.results.filter(item => item.module_code === "costs" && item.step_sort_order === lastRequiredCostsSort && item.step_status !== "completed");
  let financialBlocked = false;
  if (unsettledCosts.length) {
    const { loadBusinessProcessPolicy } = await import("./business-process-policy.server");
    const { policyEnabled } = await import("./business-process-policy");
    if (policyEnabled(await loadBusinessProcessPolicy(input.organizationId, env.DB), "settlement.require_cash_before_archive")) {
      financialBlocked = !(await (await import("./financial-closure.server")).loadFinancialClosure(env.DB, input.organizationId, input.orderId)).complete;
    }
  }
  const blockedCostsIds = new Set(financialBlocked ? unsettledCosts.map(item => item.id) : []);
  const moduleUpdates = modules.results.map<WorkflowStateWrite>((item) => {
    const completed = !blockedCostsIds.has(item.id) && workflowExecutionModuleIsComplete({
      existingStepStatus:item.step_status,
      stepSortOrder:item.step_sort_order,
      targetSortOrder:target.sort_order,
      sourceModuleStatus:moduleStatus.get(item.module_code) || "not_started",
      completionMode:item.completion_mode,
      taskCount:item.task_count,
      pendingRequired:item.pending_required,
      hasMissingRequiredFields:fieldBlockers.has(item.id),
    });
    return { id:item.id, status:completed?"completed":"pending" };
  });
  if (moduleUpdates.length) await withOrderProjectionSync(input.organizationId,input.orderId,()=>env.DB.batch(workflowModuleStateStatements(env.DB,input.instanceId,moduleUpdates,now)));

  const steps = await env.DB.prepare(
    `SELECT ss.id,ss.step_key,ss.sort_order,ss.status existing_status,
      COUNT(ms.id) module_count,
      SUM(CASE WHEN ms.is_required=1 AND ms.status!='completed' THEN 1 ELSE 0 END) pending_required
     FROM workflow_instance_step_states ss
     LEFT JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
     WHERE ss.instance_id=? GROUP BY ss.id ORDER BY ss.sort_order`,
  ).bind(input.instanceId).all<{
    id:string;step_key:string;sort_order:number;existing_status:string;
    module_count:number;pending_required:number;
  }>();
  const current = selectWorkflowExecutionCurrentStep(
    steps.results,
    input.targetStepKey,
    target.sort_order,
  );
  if (!current) return input.targetStepKey;
  const stepUpdates = steps.results.map<WorkflowStateWrite>((item) => {
    const completed = item.sort_order<current.sort_order ||
      (item.sort_order===current.sort_order && item.module_count>0 && item.pending_required===0 && item.step_key!==input.targetStepKey);
    const status = item.id===current.id ? "active" : completed ? "completed" : "pending";
    return { id:item.id, status };
  });
  await withOrderProjectionSync(input.organizationId,input.orderId,()=>env.DB.batch([
    ...workflowStepStateStatements(env.DB,input.instanceId,stepUpdates,now),
    env.DB.prepare(
      "UPDATE workflow_instances SET current_step_key=?,updated_at=? WHERE id=? AND organization_id=?",
    ).bind(current.step_key,now,input.instanceId,input.organizationId),
  ]));
  return current.step_key;
}

export type CurrentWorkflowTask = {
  id:string;
  step_key:string;
  step_name:string;
  module_code:string;
  module_name:string;
  name:string;
  task_key:string;
  task_type:string;
  status:string;
  position_name:string|null;
  assignee_user_id:string|null;
  task_assignee_user_id:string|null;
  assignee_name:string|null;
  instructions:string|null;
};

export async function listCurrentWorkflowTasks(organizationId:string,orderId:string) {
  return (await env.DB.prepare(
    `SELECT ts.id,ss.step_key,ss.step_name,ms.module_code,ms.display_name module_name,ts.task_key,ts.name,ts.task_type,ts.status,
      p.name position_name,
      COALESCE(ts.assignee_user_id,omi.assignee_user_id) assignee_user_id,
      ts.assignee_user_id task_assignee_user_id,
      assignee.display_name assignee_name,
      ts.instructions
     FROM workflow_instances wi
     JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id AND ss.step_key=wi.current_step_key
     JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
     JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
     LEFT JOIN order_module_instances omi ON omi.organization_id=wi.organization_id AND omi.order_id=wi.order_id AND omi.module_code=ms.module_code AND omi.enabled=1
     LEFT JOIN users assignee ON assignee.id=COALESCE(ts.assignee_user_id,omi.assignee_user_id)
     LEFT JOIN positions p ON p.organization_id=wi.organization_id AND p.code=COALESCE(ts.responsibility_position_code,ms.responsibility_position_code)
     WHERE wi.organization_id=? AND wi.order_id=? ORDER BY ms.sort_order,ts.sort_order`,
  ).bind(organizationId,orderId).all<CurrentWorkflowTask>()).results;
}

const manualWorkflowTaskScopeSql = `
     FROM workflow_instance_task_states ts
     JOIN workflow_instance_module_states ms ON ms.id=ts.instance_module_state_id
     JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
     JOIN workflow_instances wi ON wi.id=ss.instance_id AND wi.current_step_key=ss.step_key
     JOIN transport_orders o ON o.workflow_instance_id=wi.id AND o.id=wi.order_id AND o.organization_id=wi.organization_id
     LEFT JOIN order_module_instances omi
       ON omi.organization_id=wi.organization_id AND omi.order_id=wi.order_id
      AND omi.module_code=ms.module_code
     WHERE ts.id=? AND wi.organization_id=? AND wi.order_id=? AND ts.status!='completed'
       AND wi.status='active' AND ss.status='active' AND COALESCE(omi.enabled,1)=1
       AND o.status NOT IN ('completed','cancelled')`;

export async function completeWorkflowTask(input:{
  organizationId:string;
  orderId:string;
  taskStateId:string;
  actorUserId:string;
  /** Retained for caller compatibility; authority is reloaded from the DB. */
  actorRoleCodes?: readonly string[];
}) {
  const task = await env.DB.prepare(
    `SELECT ts.id,ts.task_key,ts.task_type,ts.status,ts.updated_at,ss.step_key,
      wi.id instance_id,wi.workflow_id,ss.id step_state_id,ms.id module_state_id,omi.id module_instance_id,o.status order_status,
      ts.assignee_user_id task_assignee_user_id,
      omi.assignee_user_id module_assignee_user_id,
      ts.responsibility_position_code task_position_code,ms.responsibility_position_code module_position_code,
      COALESCE(ts.responsibility_position_code,ms.responsibility_position_code) responsibility_position_code
     ${manualWorkflowTaskScopeSql}`,
  ).bind(input.taskStateId,input.organizationId,input.orderId).first<{
    id:string;
    task_key:string;
    task_type:string;
    status:string;
    updated_at:string;
    step_key:string;
    instance_id:string;
    workflow_id:string;
    step_state_id:string;
    module_state_id:string;
    module_instance_id:string|null;
    order_status:string;
    task_assignee_user_id:string|null;
    module_assignee_user_id:string|null;
    task_position_code:string|null;
    module_position_code:string|null;
    responsibility_position_code:string|null;
  }>();
  if (!task) throw new Error("该办理步骤不在当前节点，或已经完成");
  if (workflowSystemTaskHasAutoHandler(task.step_key, task.task_key))
    throw new Error("该步骤由对应业务模组自动完成，不能人工跳过");
  const profile = await loadActivePositionAccessProfile(env.DB,input.organizationId,input.actorUserId);
  if (!profile || !profile.permissions.includes("order.view"))
    throw new Error("账号或订单查看权限已停用，不能完成办理步骤");
  if (!canCompleteWorkflowTask({
    actorUserId: input.actorUserId,
    actorPositionCodes: [profile.positionCode],
    actorRoleCodes: [profile.roleCode],
    taskAssigneeUserId: task.task_assignee_user_id,
    moduleAssigneeUserId: task.module_assignee_user_id,
    responsibilityPositionCode: task.responsibility_position_code,
  })) throw new Error("当前账号不是该办理步骤的负责人，无权完成");
  const now = new Date().toISOString();
  const authority = activePositionProfilePredicate({organizationId:input.organizationId,userId:input.actorUserId,profile,requiredPermissions:["order.view"]});
  await guardedBatch(env.DB,[
    predicateGuard(env.DB,authority.sql,authority.values,now),
    predicateGuard(env.DB,`EXISTS(SELECT 1 ${manualWorkflowTaskScopeSql}
      AND wi.id=? AND wi.workflow_id=? AND ss.id=? AND ss.step_key=? AND ms.id=? AND COALESCE(omi.id,'')=? AND o.status=?
      AND ts.task_key=? AND ts.task_type=? AND ts.status=? AND ts.updated_at=?
      AND COALESCE(ts.assignee_user_id,'')=? AND COALESCE(omi.assignee_user_id,'')=?
      AND COALESCE(ts.responsibility_position_code,'')=? AND COALESCE(ms.responsibility_position_code,'')=?)`,[
        task.id,input.organizationId,input.orderId,task.instance_id,task.workflow_id,task.step_state_id,task.step_key,task.module_state_id,task.module_instance_id??"",task.order_status,
        task.task_key,task.task_type,task.status,task.updated_at,task.task_assignee_user_id??"",task.module_assignee_user_id??"",task.task_position_code??"",task.module_position_code??"",
      ],now),
    env.DB.prepare(
      `UPDATE workflow_instance_task_states SET status='completed',completed_by_user_id=?,completed_at=?,updated_at=? WHERE id=? AND status=? AND updated_at=?`,
    ).bind(input.actorUserId,now,now,task.id,task.status,task.updated_at),
    changedRowGuard(env.DB,now),
  ],"办理步骤、负责人或权限已变化，本次未提交；请刷新后重试");
}

export async function replaceWorkflowInstanceVersion(input:{
  organizationId:string;
  orderId:string;
  targetWorkflowId:string;
  actorUserId:string;
  affectedOrderCount?:number;
}) {
  const instance = await env.DB.prepare(
    "SELECT id,workflow_id,current_step_key,status FROM workflow_instances WHERE organization_id=? AND order_id=?",
  ).bind(input.organizationId,input.orderId).first<{
    id:string;workflow_id:string;current_step_key:string;status:string;
  }>();
  if (!instance) throw new Error("订单工作流实例不存在");
  if (instance.workflow_id === input.targetWorkflowId) return instance.id;
  const targetCurrentStep = await env.DB.prepare(
    "SELECT sort_order FROM workflow_steps WHERE workflow_id=? AND step_key=? AND is_active=1",
  ).bind(input.targetWorkflowId,instance.current_step_key).first<{sort_order:number}>();
  if (!targetCurrentStep) {
    throw new Error(`目标工作流缺少当前节点“${instance.current_step_key}”，为避免订单回退已停止切换`);
  }
  const now = new Date().toISOString();
  const changeId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workflow_instance_version_changes(
        id,organization_id,instance_id,order_id,from_workflow_id,to_workflow_id,
        preserved_current_step_key,affected_order_count,actor_user_id,reason,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,'manual_switch',?)`,
    ).bind(
      changeId,input.organizationId,instance.id,input.orderId,instance.workflow_id,
      input.targetWorkflowId,instance.current_step_key,input.affectedOrderCount??1,input.actorUserId,now,
    ),
    env.DB.prepare(
      `INSERT INTO workflow_instance_version_step_archive(
        id,change_id,step_key,step_name,sort_order,status,started_at,completed_at
       )
       SELECT lower(hex(randomblob(16))),?,step_key,step_name,sort_order,status,started_at,completed_at
       FROM workflow_instance_step_states WHERE instance_id=?`,
    ).bind(changeId,instance.id),
    env.DB.prepare(
      `INSERT INTO workflow_instance_version_task_archive(
        id,change_id,step_key,module_code,task_key,task_name,status,completed_by_user_id,completed_at
       )
       SELECT lower(hex(randomblob(16))),?,ss.step_key,ms.module_code,ts.task_key,ts.name,
              ts.status,ts.completed_by_user_id,ts.completed_at
       FROM workflow_instance_task_states ts
       JOIN workflow_instance_module_states ms ON ms.id=ts.instance_module_state_id
       JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
       WHERE ss.instance_id=?`,
    ).bind(changeId,instance.id),
    env.DB.prepare(
      `INSERT INTO workflow_field_value_audit_archive(
        id,change_id,organization_id,order_id,source_workflow_id,step_key,module_code,
        field_key,field_label,value_text,original_created_at,original_updated_at,archived_at
       )
       SELECT lower(hex(randomblob(16))),?,?,?,?,f.step_key,f.module_code,f.field_key,f.label,
              v.value_text,v.created_at,v.updated_at,?
       FROM workflow_instance_fields f
       JOIN order_custom_workflow_field_values v ON v.field_instance_id=f.id
       WHERE f.instance_id=? AND v.order_id=? AND v.organization_id=?`,
    ).bind(
      changeId,input.organizationId,input.orderId,instance.workflow_id,now,
      instance.id,input.orderId,input.organizationId,
    ),
    env.DB.prepare("DELETE FROM workflow_instance_step_states WHERE instance_id=?").bind(instance.id),
    env.DB.prepare("DELETE FROM workflow_instance_fields WHERE instance_id=?").bind(instance.id),
    env.DB.prepare(
      `UPDATE workflow_instances SET workflow_id=?,current_step_key=?,updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(input.targetWorkflowId,instance.current_step_key,now,instance.id,input.organizationId),
    env.DB.prepare(
      `INSERT INTO workflow_instance_fields(
        id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
        is_required,is_active,sort_order,options_text,help_text,handler_position_codes,created_at
       )
       SELECT lower(hex(randomblob(16))),?,f.workflow_id,s.step_key,
              COALESCE(f.module_code,'consignment'),f.field_key,f.label,f.field_type,
              f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,
              f.handler_position_codes,?
       FROM workflow_step_fields f
       JOIN workflow_steps s ON s.id=f.step_id AND s.workflow_id=f.workflow_id
       WHERE f.workflow_id=?`,
    ).bind(instance.id,now,input.targetWorkflowId),
    env.DB.prepare(
      `INSERT INTO workflow_instance_step_states(
        id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,
        started_at,completed_at,updated_at
       )
       SELECT lower(hex(randomblob(16))),?,?,s.id,s.step_key,s.name,s.sort_order,
         CASE
           WHEN ?='completed' THEN 'completed'
           WHEN s.sort_order<? THEN 'completed'
           WHEN EXISTS(
             SELECT 1 FROM workflow_instance_version_step_archive a
             WHERE a.change_id=? AND a.step_key=s.step_key AND a.status='completed'
           ) THEN 'completed'
           WHEN s.step_key=? THEN 'active'
           ELSE 'pending'
         END,
         CASE WHEN s.sort_order<=? THEN COALESCE((
           SELECT a.started_at FROM workflow_instance_version_step_archive a
           WHERE a.change_id=? AND a.step_key=s.step_key
         ),?) ELSE NULL END,
         CASE WHEN ?='completed' OR s.sort_order<? OR EXISTS(
           SELECT 1 FROM workflow_instance_version_step_archive a
           WHERE a.change_id=? AND a.step_key=s.step_key AND a.status='completed'
         ) THEN COALESCE((
           SELECT a.completed_at FROM workflow_instance_version_step_archive a
           WHERE a.change_id=? AND a.step_key=s.step_key
         ),?) ELSE NULL END,
         ?
       FROM workflow_steps s WHERE s.workflow_id=? AND s.is_active=1`,
    ).bind(
      instance.id,input.targetWorkflowId,instance.status,targetCurrentStep.sort_order,changeId,
      instance.current_step_key,targetCurrentStep.sort_order,changeId,now,instance.status,
      targetCurrentStep.sort_order,changeId,changeId,now,now,input.targetWorkflowId,
    ),
    env.DB.prepare(
      `INSERT INTO workflow_instance_module_states(
        id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,status,
        responsibility_position_code,completion_mode,updated_at
       )
       SELECT lower(hex(randomblob(16))),ss.id,m.id,m.module_code,m.display_name,m.sort_order,m.is_required,
         CASE WHEN ss.status='completed' THEN 'completed' ELSE 'pending' END,
         m.responsibility_position_code,m.completion_mode,?
       FROM workflow_instance_step_states ss
       JOIN workflow_step_modules m
         ON m.workflow_id=ss.workflow_id AND m.step_id=ss.step_id AND m.is_active=1
       WHERE ss.instance_id=?`,
    ).bind(now,instance.id),
    env.DB.prepare(
      `INSERT INTO workflow_instance_task_states(
        id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,is_required,status,
        responsibility_position_code,instructions,completed_by_user_id,completed_at,updated_at
       )
       SELECT lower(hex(randomblob(16))),ms.id,t.id,t.task_key,t.name,t.task_type,t.sort_order,t.is_required,
         CASE WHEN ss.status='completed' OR EXISTS(
           SELECT 1 FROM workflow_instance_version_task_archive a
           WHERE a.change_id=? AND a.step_key=ss.step_key AND a.module_code=ms.module_code
             AND a.task_key=t.task_key AND a.status='completed'
         ) THEN 'completed' ELSE 'pending' END,
         COALESCE(t.responsibility_position_code,ms.responsibility_position_code),t.instructions,
         (SELECT a.completed_by_user_id FROM workflow_instance_version_task_archive a
          WHERE a.change_id=? AND a.step_key=ss.step_key AND a.module_code=ms.module_code
            AND a.task_key=t.task_key AND a.status='completed' LIMIT 1),
         CASE WHEN ss.status='completed' THEN COALESCE((
           SELECT a.completed_at FROM workflow_instance_version_task_archive a
           WHERE a.change_id=? AND a.step_key=ss.step_key AND a.module_code=ms.module_code
             AND a.task_key=t.task_key AND a.status='completed' LIMIT 1
         ),?) ELSE (
           SELECT a.completed_at FROM workflow_instance_version_task_archive a
           WHERE a.change_id=? AND a.step_key=ss.step_key AND a.module_code=ms.module_code
             AND a.task_key=t.task_key AND a.status='completed' LIMIT 1
         ) END,?
       FROM workflow_instance_module_states ms
       JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
       JOIN workflow_module_tasks t
         ON t.workflow_id=ss.workflow_id AND t.step_module_id=ms.step_module_id AND t.is_active=1
       WHERE ss.instance_id=?`,
    ).bind(changeId,changeId,changeId,now,changeId,now,instance.id),
    env.DB.prepare(
      `INSERT INTO order_custom_workflow_field_values(
        id,organization_id,order_id,field_instance_id,value_text,created_at,updated_at
       )
       SELECT lower(hex(randomblob(16))),a.organization_id,a.order_id,f.id,a.value_text,?,?
       FROM workflow_field_value_audit_archive a
       JOIN workflow_instance_fields f
         ON f.instance_id=? AND f.field_key=a.field_key AND f.module_code=a.module_code
       WHERE a.change_id=?
         AND f.id=(
           SELECT candidate.id FROM workflow_instance_fields candidate
           WHERE candidate.instance_id=f.instance_id AND candidate.field_key=a.field_key
             AND candidate.module_code=a.module_code
           ORDER BY candidate.is_active DESC,candidate.sort_order,candidate.id LIMIT 1
         )`,
    ).bind(now,now,instance.id,changeId),
    env.DB.prepare(
      `INSERT INTO workflow_history(
        id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at
       )
       SELECT ?,?,?,s.name,?,'admin',?,?
       FROM workflow_steps s WHERE s.workflow_id=? AND s.step_key=?`,
    ).bind(
      crypto.randomUUID(),instance.id,instance.current_step_key,input.actorUserId,
      JSON.stringify({
        versionChanged:true,
        changeId,
        fromWorkflowId:instance.workflow_id,
        toWorkflowId:input.targetWorkflowId,
        historicalStepsPreserved:true,
      }),now,input.targetWorkflowId,instance.current_step_key,
    ),
  ]);
  return instance.id;
}

export type WorkflowVersionSwitchImpact = {
  orderIds:string[];
  affectedOrderCount:number;
  completedOrderCount:number;
  completedStepCount:number;
  batchNumber:string|null;
  currentStepKey:string|null;
  currentStepName:string|null;
  hasActualExit:boolean;
  allowed:boolean;
  reason:string|null;
};

export async function inspectWorkflowVersionSwitchImpact(
  organizationId:string,
  orderId:string,
):Promise<WorkflowVersionSwitchImpact> {
  const order = await env.DB.prepare(
    `SELECT o.id,o.status,wi.current_step_key,ws.name current_step_name,
      (SELECT COUNT(*) FROM workflow_instance_step_states ss
       WHERE ss.instance_id=wi.id AND ss.status='completed') completed_step_count,
      EXISTS(
        SELECT 1 FROM order_tracking_milestones tm
        WHERE tm.organization_id=o.organization_id AND tm.order_id=o.id
          AND tm.milestone_code IN ('exported','actual_exit','exit')
      ) order_exited
     FROM transport_orders o
     LEFT JOIN workflow_instances wi ON wi.organization_id=o.organization_id AND wi.order_id=o.id
     LEFT JOIN workflow_steps ws ON ws.workflow_id=wi.workflow_id AND ws.step_key=wi.current_step_key
     WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId,orderId).first<{
    id:string;status:string;current_step_key:string|null;current_step_name:string|null;
    completed_step_count:number;order_exited:number;
  }>();
  if (!order) {
    return {
      orderIds:[],affectedOrderCount:0,completedOrderCount:0,completedStepCount:0,
      batchNumber:null,currentStepKey:null,currentStepName:null,hasActualExit:false,
      allowed:false,reason:"订单不存在。",
    };
  }
  const batch = await env.DB.prepare(
    `SELECT b.id,b.batch_number,
      EXISTS(SELECT 1 FROM transport_exit_confirmations ec WHERE ec.batch_id=b.id) has_exit
     FROM transport_batch_orders bo
     JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.status!='cancelled'
     ORDER BY b.created_at DESC LIMIT 1`,
  ).bind(organizationId,orderId).first<{id:string;batch_number:string;has_exit:number}>();
  const orderRows = batch
    ? await env.DB.prepare(
        `SELECT o.id,o.status FROM transport_batch_orders bo
         JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
         WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'`,
      ).bind(organizationId,batch.id).all<{id:string;status:string}>()
    : { results:[{id:order.id,status:order.status}] };
  const orderIds = orderRows.results.map((item)=>item.id);
  const completedOrderCount = orderRows.results.filter((item)=>item.status==="completed").length;
  const hasActualExit = Boolean(order.order_exited || batch?.has_exit);
  const decision = workflowVersionSwitchDecision({
    affectedOrderCount:orderIds.length,
    completedOrderCount,
    hasActualExit,
  });
  return {
    orderIds,
    affectedOrderCount:orderIds.length,
    completedOrderCount,
    completedStepCount:Number(order.completed_step_count||0),
    batchNumber:batch?.batch_number??null,
    currentStepKey:order.current_step_key,
    currentStepName:order.current_step_name,
    hasActualExit,
    allowed:decision.allowed,
    reason:decision.reason,
  };
}
