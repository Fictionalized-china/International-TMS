import { env } from "cloudflare:workers";
import type { OrderModuleCode } from "./order-modules";
import { orderDocumentPlacements } from "./order-documents";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";
import { workflowFieldKeyCandidates } from "./workflow-field-runtime";

export type WorkflowFieldPolicyImpact = {
  total:number;
  future:number;
  current:number;
  historical:number;
  auditOnly:number;
};

export type WorkflowSupplementTask = {
  id:string;
  target_step_key:string;
  target_step_name:string|null;
  module_code:OrderModuleCode;
  field_key:string;
  field_label:string;
  task_kind:"supplement"|"audit_only";
  status:"open"|"completed"|"cancelled";
  reason:string;
  resolution_note:string|null;
  created_at:string;
  completed_at:string|null;
  completed_by_name:string|null;
};

type WorkflowSupplementCandidate = {
  instance_id:string;
  order_id:string;
  audit_only:number;
};

type OpenWorkflowSupplementTask = {
  instance_id:string;
  target_step_key:string;
  module_code:OrderModuleCode;
  field_key:string;
  field_label:string;
};

export async function inspectWorkflowFieldPolicyImpact(
  workflowId:string,
  targetStepKey:string,
):Promise<WorkflowFieldPolicyImpact> {
  const result = await env.DB.prepare(
    `SELECT
      COUNT(wi.id) total,
      SUM(CASE WHEN current_step.sort_order<target_step.sort_order THEN 1 ELSE 0 END) future_count,
      SUM(CASE WHEN current_step.sort_order=target_step.sort_order THEN 1 ELSE 0 END) current_count,
      SUM(CASE WHEN current_step.sort_order>target_step.sort_order
        AND wi.status!='completed'
        AND NOT EXISTS(
          SELECT 1 FROM transport_batch_orders bo
          JOIN transport_exit_confirmations ec ON ec.batch_id=bo.batch_id
          WHERE bo.order_id=wi.order_id AND bo.status!='removed'
        )
        AND NOT EXISTS(
          SELECT 1 FROM order_tracking_milestones tm
          WHERE tm.order_id=wi.order_id AND tm.milestone_code IN ('exported','actual_exit','exit')
        ) THEN 1 ELSE 0 END) historical_count,
      SUM(CASE WHEN current_step.sort_order>target_step.sort_order AND (
        wi.status='completed'
        OR EXISTS(
          SELECT 1 FROM transport_batch_orders bo
          JOIN transport_exit_confirmations ec ON ec.batch_id=bo.batch_id
          WHERE bo.order_id=wi.order_id AND bo.status!='removed'
        )
        OR EXISTS(
          SELECT 1 FROM order_tracking_milestones tm
          WHERE tm.order_id=wi.order_id AND tm.milestone_code IN ('exported','actual_exit','exit')
        )
      ) THEN 1 ELSE 0 END) audit_count
     FROM workflow_steps target_step
     LEFT JOIN workflow_instances wi ON wi.workflow_id=target_step.workflow_id AND wi.order_id IS NOT NULL
     LEFT JOIN workflow_steps current_step
       ON current_step.workflow_id=wi.workflow_id AND current_step.step_key=wi.current_step_key
     WHERE target_step.workflow_id=? AND target_step.step_key=?`,
  ).bind(workflowId,targetStepKey).first<{
    total:number;future_count:number;current_count:number;historical_count:number;audit_count:number;
  }>();
  return {
    total:Number(result?.total||0),
    future:Number(result?.future_count||0),
    current:Number(result?.current_count||0),
    historical:Number(result?.historical_count||0),
    auditOnly:Number(result?.audit_count||0),
  };
}

export async function synchronizeWorkflowSupplementTasks(input:{
  organizationId:string;
  workflowId:string;
  targetStepKey:string;
  moduleCode:OrderModuleCode;
  fieldKey:string;
  fieldLabel:string;
  mode:"required"|"optional"|"hidden";
  actorUserId:string;
}) {
  const now = new Date().toISOString();
  if (input.mode !== "required") {
    const cancelled = await env.DB.prepare(
      `UPDATE workflow_supplement_tasks
       SET status='cancelled',resolution_note=?,completed_by_user_id=?,completed_at=?,updated_at=?
       WHERE organization_id=? AND workflow_id=? AND module_code=? AND field_key=? AND status='open'`,
    ).bind(
      input.mode === "hidden" ? "字段已隐藏，补录任务关闭；历史值继续保留审计。" : "字段已改为选填，补录任务关闭。",
      input.actorUserId,now,now,input.organizationId,input.workflowId,input.moduleCode,input.fieldKey,
    ).run();
    return { created:0,cancelled:Number(cancelled.meta?.changes||0),autoCompleted:0 };
  }
  const candidates = await env.DB.prepare(
    `SELECT wi.id instance_id,wi.order_id,
       CASE WHEN wi.status='completed'
         OR EXISTS(
           SELECT 1 FROM transport_batch_orders bo
           JOIN transport_exit_confirmations ec ON ec.batch_id=bo.batch_id
           WHERE bo.order_id=wi.order_id AND bo.status!='removed'
         )
         OR EXISTS(
           SELECT 1 FROM order_tracking_milestones tm
           WHERE tm.order_id=wi.order_id AND tm.milestone_code IN ('exported','actual_exit','exit')
         ) THEN 1 ELSE 0 END audit_only
     FROM workflow_instances wi
     JOIN workflow_steps current_step
       ON current_step.workflow_id=wi.workflow_id AND current_step.step_key=wi.current_step_key
     JOIN workflow_steps target_step
       ON target_step.workflow_id=wi.workflow_id AND target_step.step_key=?
     WHERE wi.organization_id=? AND wi.workflow_id=? AND wi.order_id IS NOT NULL
       AND current_step.sort_order>target_step.sort_order`,
  ).bind(
    input.targetStepKey,input.organizationId,input.workflowId,
  ).all<WorkflowSupplementCandidate>();

  const missing:WorkflowSupplementCandidate[]=[];
  const alreadyPresent:WorkflowSupplementCandidate[]=[];
  // Keep the reads bounded and deterministic. A field-policy change can affect
  // many historical orders, but it must never create a task merely because the
  // order has already passed the node.
  for (const candidate of candidates.results) {
    const present=await workflowSupplementFieldIsPresent({
      organizationId:input.organizationId,
      orderId:candidate.order_id,
      targetStepKey:input.targetStepKey,
      moduleCode:input.moduleCode,
      fieldKey:input.fieldKey,
    });
    (present?alreadyPresent:missing).push(candidate);
  }

  const writes:D1PreparedStatement[]=[];
  for (const candidate of alreadyPresent) {
    writes.push(env.DB.prepare(
      `UPDATE workflow_supplement_tasks
       SET status='completed',resolution_note=?,completed_by_user_id=?,completed_at=?,updated_at=?
       WHERE organization_id=? AND workflow_id=? AND instance_id=? AND module_code=?
         AND field_key=? AND status='open'`,
    ).bind(
      "系统检测到字段或文件已经补齐，任务自动完成。",
      input.actorUserId,now,now,input.organizationId,input.workflowId,
      candidate.instance_id,input.moduleCode,input.fieldKey,
    ));
  }
  for (const candidate of missing) {
    const auditOnly=candidate.audit_only===1;
    writes.push(env.DB.prepare(
      `INSERT OR IGNORE INTO workflow_supplement_tasks(
        id,organization_id,workflow_id,instance_id,order_id,target_step_key,module_code,
        field_key,field_label,task_kind,status,reason,created_by_user_id,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),input.organizationId,input.workflowId,candidate.instance_id,
      candidate.order_id,input.targetStepKey,input.moduleCode,input.fieldKey,input.fieldLabel,
      auditOnly?"audit_only":"supplement",
      auditOnly
        ? "订单已出境或完成：仅补录审计，不回退历史节点。"
        : "字段改为必填时订单已通过所属节点：创建补录任务，不回退历史节点。",
      input.actorUserId,now,now,
    ));
  }
  let created=0,autoCompleted=0;
  for (let index=0;index<writes.length;index+=80) {
    const results=await env.DB.batch(writes.slice(index,index+80));
    for (let offset=0;offset<results.length;offset+=1) {
      const changes=Number(results[offset]?.meta?.changes||0);
      if (index+offset<alreadyPresent.length) autoCompleted+=changes;
      else created+=changes;
    }
  }
  return { created,cancelled:0,autoCompleted };
}

export async function workflowSupplementFieldIsPresent(input:{
  organizationId:string;
  orderId:string;
  targetStepKey:string;
  moduleCode:OrderModuleCode;
  fieldKey:string;
}) {
  const placement=orderDocumentPlacements.find((item)=>
    item.moduleCode===input.moduleCode&&item.fieldKey===input.fieldKey,
  );
  if (placement) {
    const stored=await env.DB.prepare(
      `SELECT COUNT(*) total
       FROM order_attachments a
       JOIN order_document_metadata m ON m.attachment_id=a.id
       WHERE a.organization_id=? AND a.order_id=? AND m.organization_id=?
         AND m.order_id=? AND m.document_category=?`,
    ).bind(
      input.organizationId,input.orderId,input.organizationId,input.orderId,
      placement.documentCode,
    ).first<{total:number}>();
    return Number(stored?.total||0)>0;
  }
  const fields=await loadOrderModuleWorkflowFields(
    input.organizationId,input.orderId,input.moduleCode,
  );
  const candidates=workflowFieldKeyCandidates(input.fieldKey);
  const exact=candidates
    .map((fieldKey)=>fields.find((field)=>
      field.stepKey===input.targetStepKey&&field.fieldKey===fieldKey,
    ))
    .find(Boolean);
  const matching=exact??candidates
    .map((fieldKey)=>fields.find((field)=>field.fieldKey===fieldKey))
    .find(Boolean);
  return matching?.present===true;
}

export async function listOrderSupplementTasks(
  organizationId:string,
  orderId:string,
) {
  return (await env.DB.prepare(
    `SELECT t.id,t.target_step_key,s.name target_step_name,t.module_code,t.field_key,
      t.field_label,t.task_kind,t.status,t.reason,t.resolution_note,t.created_at,t.completed_at,
      u.display_name completed_by_name
     FROM workflow_supplement_tasks t
     LEFT JOIN workflow_steps s ON s.workflow_id=t.workflow_id AND s.step_key=t.target_step_key
     LEFT JOIN users u ON u.id=t.completed_by_user_id
     WHERE t.organization_id=? AND t.order_id=?
     ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,t.created_at DESC`,
  ).bind(organizationId,orderId).all<WorkflowSupplementTask>()).results;
}

export async function completeWorkflowSupplementTask(input:{
  organizationId:string;
  orderId:string;
  taskId:string;
  actorUserId:string;
  resolutionNote:string;
}) {
  if (input.resolutionNote.trim().length < 2) throw new Error("请填写至少 2 个字的补录或复核说明");
  const task=await env.DB.prepare(
    `SELECT instance_id,target_step_key,module_code,field_key,field_label
     FROM workflow_supplement_tasks
     WHERE id=? AND organization_id=? AND order_id=? AND status='open'`,
  ).bind(input.taskId,input.organizationId,input.orderId).first<OpenWorkflowSupplementTask>();
  if (!task) throw new Error("补录任务不存在或已经处理");
  const present=await workflowSupplementFieldIsPresent({
    organizationId:input.organizationId,
    orderId:input.orderId,
    targetStepKey:task.target_step_key,
    moduleCode:task.module_code,
    fieldKey:task.field_key,
  });
  if (!present) throw new Error(`请先补齐“${task.field_label}”的真实字段或文件，再完成补录任务`);
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(
    `UPDATE workflow_supplement_tasks
     SET status='completed',completed_by_user_id=?,resolution_note=?,completed_at=?,updated_at=?
     WHERE id=? AND organization_id=? AND order_id=? AND status='open'`,
  ).bind(
    input.actorUserId,input.resolutionNote.trim(),now,now,input.taskId,input.organizationId,input.orderId,
  ).run();
  if (!Number(updated.meta?.changes||0)) throw new Error("补录任务不存在或已经处理");
}
