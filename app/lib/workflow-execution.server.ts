import { env } from "cloudflare:workers";
import {
  missingRequiredWorkflowModuleStepFields,
  snapshotWorkflowFieldsForInstance,
} from "./workflow-fields.server";
import type { OrderModuleCode } from "./order-modules";

type ModuleFact = { module_code:string; status:string };

export async function ensureWorkflowExecutionSnapshot(input:{
  instanceId:string;
  workflowId:string;
}) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_instance_step_states(
      id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at
     )
     SELECT lower(hex(randomblob(16))),?,?,s.id,s.step_key,s.name,s.sort_order,'pending',?
     FROM workflow_steps s WHERE s.workflow_id=? AND s.is_active=1`,
  ).bind(input.instanceId,input.workflowId,now,input.workflowId).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_instance_module_states(
      id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,status,
      responsibility_position_code,completion_mode,updated_at
     )
     SELECT lower(hex(randomblob(16))),ss.id,m.id,m.module_code,m.display_name,m.sort_order,m.is_required,'pending',
       m.responsibility_position_code,m.completion_mode,?
     FROM workflow_instance_step_states ss JOIN workflow_step_modules m
       ON m.workflow_id=ss.workflow_id AND m.step_id=ss.step_id AND m.is_active=1
     WHERE ss.instance_id=?`,
  ).bind(now,input.instanceId).run();
  await env.DB.prepare(
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
  ).bind(now,input.instanceId).run();
}

export async function synchronizeWorkflowExecution(input:{
  organizationId:string;
  orderId:string;
  instanceId:string;
  workflowId:string;
  targetStepKey:string;
  orderStatus:string;
  mandatoryModuleCodes?:string[];
}) {
  await ensureWorkflowExecutionSnapshot({instanceId:input.instanceId,workflowId:input.workflowId});
  const mandatoryModuleCodes = [...new Set(input.mandatoryModuleCodes ?? [])];
  if (mandatoryModuleCodes.length) {
    await env.DB.prepare(
      `UPDATE workflow_instance_module_states SET is_required=1,updated_at=?
       WHERE module_code IN (${mandatoryModuleCodes.map(() => "?").join(",")})
         AND instance_step_state_id IN (
           SELECT id FROM workflow_instance_step_states WHERE instance_id=?
         )`,
    ).bind(new Date().toISOString(), ...mandatoryModuleCodes, input.instanceId).run();
  }
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
    await env.DB.batch([
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
    ]);
    return input.targetStepKey;
  }
  const moduleStatus = new Map(moduleFacts.results.map((item)=>[item.module_code,item.status]));
  const taskUpdates = [];
  for (const row of rows.results) {
    if (!row.task_state_id || row.task_status === "completed") continue;
    const autoComplete = shouldAutoCompleteTemplateTask(
      row.step_key,row.task_key || "",input.orderStatus,moduleStatus.get(row.module_code || "") || "not_started",
    );
    if (autoComplete) {
      taskUpdates.push(env.DB.prepare(
        `UPDATE workflow_instance_task_states SET status='completed',completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=?`,
      ).bind(now,now,row.task_state_id));
    }
  }
  if (taskUpdates.length) await env.DB.batch(taskUpdates);

  const modules = await env.DB.prepare(
    `SELECT ms.id,ms.instance_step_state_id,ms.is_required,ms.completion_mode,ms.module_code,ss.step_key,
      COUNT(ts.id) task_count,
      SUM(CASE WHEN ts.is_required=1 AND ts.status!='completed' THEN 1 ELSE 0 END) pending_required
     FROM workflow_instance_module_states ms
     LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
     JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
     WHERE ss.instance_id=? GROUP BY ms.id`,
  ).bind(input.instanceId).all<{
    id:string;instance_step_state_id:string;is_required:number;completion_mode:string;
    module_code:string;step_key:string;
    task_count:number;pending_required:number;
  }>();
  const fieldBlockers = new Set<string>();
  await Promise.all(modules.results.map(async (item) => {
    const missing = await missingRequiredWorkflowModuleStepFields(
      input.organizationId,
      input.orderId,
      item.step_key,
      item.module_code as OrderModuleCode,
    );
    if (missing.length) fieldBlockers.add(item.id);
  }));
  const moduleUpdates = modules.results.map((item) => {
    const taskComplete = item.completion_mode === "automatic"
      ? item.task_count === 0 || item.pending_required === 0
      : item.task_count > 0 && item.pending_required === 0;
    const completed = taskComplete && !fieldBlockers.has(item.id);
    return env.DB.prepare(
      "UPDATE workflow_instance_module_states SET status=?,updated_at=? WHERE id=?",
    ).bind(completed?"completed":"pending",now,item.id);
  });
  if (moduleUpdates.length) await env.DB.batch(moduleUpdates);

  const steps = await env.DB.prepare(
    `SELECT ss.id,ss.step_key,ss.sort_order,
      COUNT(ms.id) module_count,
      SUM(CASE WHEN ms.is_required=1 AND ms.status!='completed' THEN 1 ELSE 0 END) pending_required
     FROM workflow_instance_step_states ss
     LEFT JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
     WHERE ss.instance_id=? GROUP BY ss.id ORDER BY ss.sort_order`,
  ).bind(input.instanceId).all<{
    id:string;step_key:string;sort_order:number;module_count:number;pending_required:number;
  }>();
  const reachable = steps.results.filter((item)=>item.sort_order<=target.sort_order);
  const current = reachable.find((item)=>item.module_count===0 || item.pending_required>0) ??
    reachable[reachable.length - 1] ?? steps.results[0];
  if (!current) return input.targetStepKey;
  const stepUpdates = steps.results.map((item) => {
    const completed = item.sort_order<current.sort_order ||
      (item.sort_order===current.sort_order && item.module_count>0 && item.pending_required===0 && item.step_key!==input.targetStepKey);
    const status = item.id===current.id ? "active" : completed ? "completed" : "pending";
    return env.DB.prepare(
      `UPDATE workflow_instance_step_states SET status=?,started_at=CASE WHEN ?='active' THEN COALESCE(started_at,?) ELSE started_at END,
        completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,updated_at=? WHERE id=?`,
    ).bind(status,status,now,status,now,now,item.id);
  });
  await env.DB.batch([
    ...stepUpdates,
    env.DB.prepare(
      "UPDATE workflow_instances SET current_step_key=?,updated_at=? WHERE id=? AND organization_id=?",
    ).bind(current.step_key,now,input.instanceId,input.organizationId),
  ]);
  return current.step_key;
}

function shouldAutoCompleteTemplateTask(
  stepKey:string,
  taskKey:string,
  orderStatus:string,
  moduleStatus:string,
) {
  if (!taskKey.startsWith("handle_")) return false;
  if (stepKey === "order_creation") return orderStatus !== "draft";
  if (stepKey === "consignment_approval") return ["confirmed","in_execution","completed"].includes(orderStatus);
  if (stepKey === "task_assignment") return ["in_execution","completed"].includes(orderStatus);
  if (stepKey.startsWith("custom_")) return false;
  return moduleStatus === "completed";
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
  instructions:string|null;
};

export async function listCurrentWorkflowTasks(organizationId:string,orderId:string) {
  return (await env.DB.prepare(
    `SELECT ts.id,ss.step_key,ss.step_name,ms.module_code,ms.display_name module_name,ts.task_key,ts.name,ts.task_type,ts.status,
      p.name position_name,ts.instructions
     FROM workflow_instances wi
     JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id AND ss.step_key=wi.current_step_key
     JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
     JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
     LEFT JOIN positions p ON p.organization_id=wi.organization_id AND p.code=COALESCE(ts.responsibility_position_code,ms.responsibility_position_code)
     WHERE wi.organization_id=? AND wi.order_id=? ORDER BY ms.sort_order,ts.sort_order`,
  ).bind(organizationId,orderId).all<CurrentWorkflowTask>()).results;
}

export async function completeWorkflowTask(input:{
  organizationId:string;
  orderId:string;
  taskStateId:string;
  actorUserId:string;
}) {
  const task = await env.DB.prepare(
    `SELECT ts.id,ts.task_key,ss.step_key FROM workflow_instance_task_states ts
     JOIN workflow_instance_module_states ms ON ms.id=ts.instance_module_state_id
     JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
     JOIN workflow_instances wi ON wi.id=ss.instance_id AND wi.current_step_key=ss.step_key
     WHERE ts.id=? AND wi.organization_id=? AND wi.order_id=? AND ts.status!='completed'`,
  ).bind(input.taskStateId,input.organizationId,input.orderId).first<{id:string;task_key:string;step_key:string}>();
  if (!task) throw new Error("该办理步骤不在当前节点，或已经完成");
  if (task.task_key.startsWith("handle_") && !task.step_key.startsWith("custom_"))
    throw new Error("该步骤由对应业务模组自动完成，不能人工跳过");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE workflow_instance_task_states SET status='completed',completed_by_user_id=?,completed_at=?,updated_at=? WHERE id=?`,
  ).bind(input.actorUserId,now,now,task.id).run();
}

export async function replaceWorkflowInstanceVersion(input:{
  organizationId:string;
  orderId:string;
  targetWorkflowId:string;
}) {
  const instance = await env.DB.prepare(
    "SELECT id,workflow_id FROM workflow_instances WHERE organization_id=? AND order_id=?",
  ).bind(input.organizationId,input.orderId).first<{id:string;workflow_id:string}>();
  if (!instance) throw new Error("订单工作流实例不存在");
  if (instance.workflow_id === input.targetWorkflowId) return instance.id;
  const values = await env.DB.prepare(
    `SELECT f.field_key,f.module_code,v.value_text
     FROM workflow_instance_fields f JOIN order_custom_workflow_field_values v ON v.field_instance_id=f.id
     WHERE f.instance_id=? AND v.order_id=? AND v.organization_id=?`,
  ).bind(instance.id,input.orderId,input.organizationId).all<{
    field_key:string;module_code:string;value_text:string|null;
  }>();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workflow_instance_step_states WHERE instance_id=?").bind(instance.id),
    env.DB.prepare("DELETE FROM workflow_instance_fields WHERE instance_id=?").bind(instance.id),
    env.DB.prepare(
      `UPDATE workflow_instances SET workflow_id=?,current_step_key='order_creation',status='active',
        completed_at=NULL,updated_at=? WHERE id=? AND organization_id=?`,
    ).bind(input.targetWorkflowId,now,instance.id,input.organizationId),
  ]);
  await snapshotWorkflowFieldsForInstance({
    organizationId:input.organizationId,
    instanceId:instance.id,
    workflowId:input.targetWorkflowId,
  });
  await ensureWorkflowExecutionSnapshot({instanceId:instance.id,workflowId:input.targetWorkflowId});
  if (values.results.length) {
    const fields = await env.DB.prepare(
      "SELECT id,field_key,module_code FROM workflow_instance_fields WHERE instance_id=?",
    ).bind(instance.id).all<{id:string;field_key:string;module_code:string}>();
    const statements = values.results.map((value) => {
      const field = fields.results.find((item)=>item.field_key===value.field_key&&item.module_code===value.module_code);
      if (!field) return null;
      return env.DB.prepare(
        `INSERT INTO order_custom_workflow_field_values(
          id,organization_id,order_id,field_instance_id,value_text,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(),input.organizationId,input.orderId,field.id,value.value_text,now,now);
    }).filter(Boolean) as D1PreparedStatement[];
    if (statements.length) await env.DB.batch(statements);
  }
  return instance.id;
}
