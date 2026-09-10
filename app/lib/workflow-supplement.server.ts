import { env } from "cloudflare:workers";
import type { OrderModuleCode } from "./order-modules";
import {
  maxInlineOrderDocumentBytes,
  orderDocumentPlacements,
  orderDocumentTypeLabel,
} from "./order-documents";
import {
  currentStageLoadingDocumentRequirements,
} from "./loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "./loading-document-requirements.server";
import { orderDocumentSupplementNotificationStatement } from "./internal-notifications.server";
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

type SupplementDocumentTask = OpenWorkflowSupplementTask & {
  task_kind:"supplement"|"audit_only";
  customer_id:string;
  salesperson_user_id:string|null;
};

const supplementDocumentContentTypes=new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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
  if (orderDocumentPlacements.some((item)=>
    item.moduleCode===input.moduleCode&&item.fieldKey===input.fieldKey,
  )) {
    for (const candidate of missing) {
      await orderDocumentSupplementNotificationStatement(env.DB,{
        organizationId:input.organizationId,
        orderId:candidate.order_id,
        fieldLabel:input.fieldLabel,
        actorUserId:input.actorUserId,
        now,
      }).run();
    }
  }
  return { created,cancelled:0,autoCompleted };
}

export async function ensureMissingLoadingDocumentSupplements(input:{
  organizationId:string;
  orderIds:readonly string[];
  actorUserId:string|null;
}) {
  const orderIds=[...new Set(input.orderIds.filter(Boolean))];
  if (!orderIds.length) return {created:0,autoCompleted:0,notified:0};
  const requirements=await loadOrderLoadingDocumentRequirements(
    input.organizationId,orderIds,
  );
  const now=new Date().toISOString();
  let created=0,autoCompleted=0,notified=0;
  for (const group of requirements) {
    for (const requirement of currentStageLoadingDocumentRequirements(group.documents)) {
      if (!requirement.isRequired) continue;
      const snapshot=await env.DB.prepare(
        `SELECT wi.id instance_id,wi.workflow_id,f.step_key target_step_key
         FROM transport_orders o
         JOIN workflow_instances wi
           ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id AND wi.order_id=o.id
         JOIN workflow_instance_fields f
           ON f.instance_id=wi.id AND f.module_code=? AND f.field_key=?
            AND f.is_active=1 AND f.is_required=1
         WHERE o.organization_id=? AND o.id=?`,
      ).bind(
        requirement.moduleCode,requirement.fieldKey,input.organizationId,group.orderId,
      ).first<{instance_id:string;workflow_id:string;target_step_key:string}>();
      if (!snapshot) continue;
      const present=await workflowSupplementFieldIsPresent({
        organizationId:input.organizationId,
        orderId:group.orderId,
        targetStepKey:snapshot.target_step_key,
        moduleCode:requirement.moduleCode,
        fieldKey:requirement.fieldKey,
      });
      if (present) {
        const completed=await env.DB.prepare(
          `UPDATE workflow_supplement_tasks
           SET status='completed',resolution_note='系统检测到必传文件已经补齐，任务自动完成。',
             completed_by_user_id=?,completed_at=?,updated_at=?
           WHERE organization_id=? AND instance_id=? AND module_code=? AND field_key=? AND status='open'`,
        ).bind(
          input.actorUserId,now,now,input.organizationId,snapshot.instance_id,
          requirement.moduleCode,requirement.fieldKey,
        ).run();
        autoCompleted+=Number(completed.meta?.changes||0);
        continue;
      }
      const inserted=await env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_supplement_tasks(
          id,organization_id,workflow_id,instance_id,order_id,target_step_key,module_code,
          field_key,field_label,task_kind,status,reason,created_by_user_id,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,'supplement','open',?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),input.organizationId,snapshot.workflow_id,snapshot.instance_id,
        group.orderId,snapshot.target_step_key,requirement.moduleCode,requirement.fieldKey,
        requirement.name,
        "装车或配载资料检查发现必传文件缺失；订单节点不回退，请原业务员通过补录门户补齐。",
        input.actorUserId,now,now,
      ).run();
      created+=Number(inserted.meta?.changes||0);
      const notification=await orderDocumentSupplementNotificationStatement(env.DB,{
        organizationId:input.organizationId,
        orderId:group.orderId,
        fieldLabel:requirement.name,
        actorUserId:input.actorUserId,
        now,
      }).run();
      notified+=Number(notification.meta?.changes||0);
    }
  }
  return {created,autoCompleted,notified};
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

export async function uploadWorkflowSupplementDocument(input:{
  organizationId:string;
  orderId:string;
  taskId:string;
  actorUserId:string;
  allowSystemOverride:boolean;
  file:File;
}) {
  const task=await env.DB.prepare(
    `SELECT t.instance_id,t.target_step_key,t.module_code,t.field_key,t.field_label,t.task_kind,
       o.customer_id,COALESCE(q.salesperson_user_id,o.salesperson_user_id) salesperson_user_id
     FROM workflow_supplement_tasks t
     JOIN transport_orders o ON o.id=t.order_id AND o.organization_id=t.organization_id
     LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
     WHERE t.id=? AND t.organization_id=? AND t.order_id=? AND t.status='open'`,
  ).bind(
    input.taskId,input.organizationId,input.orderId,
  ).first<SupplementDocumentTask>();
  if (!task) throw new Error("补录任务不存在或已经处理");
  if (task.task_kind!=="supplement") throw new Error("该任务仅允许审计复核，不能补传文件");
  if (!input.allowSystemOverride&&task.salesperson_user_id!==input.actorUserId) {
    throw new Error("该补录入口仅向本订单绑定的业务员开放");
  }
  const placement=orderDocumentPlacements.find((item)=>
    item.moduleCode===task.module_code&&item.fieldKey===task.field_key,
  );
  if (!placement) throw new Error("该补录任务不是文件任务，不能在此上传");
  if (!(input.file instanceof File)||input.file.size<=0) throw new Error("请选择需要补录的文件");
  if (input.file.size>maxInlineOrderDocumentBytes||!supplementDocumentContentTypes.has(input.file.type)) {
    throw new Error("仅支持 PDF、Word、Excel 和图片；单个文件不能超过 1.2MB");
  }
  const now=new Date().toISOString();
  const attachmentId=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO order_attachments(
        id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,
        uploaded_by_user_id,source,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)`,
    ).bind(
      attachmentId,input.organizationId,input.orderId,task.customer_id,input.file.name,
      input.file.type,input.file.size,await supplementFileToDataUrl(input.file),input.actorUserId,now,
    ),
    env.DB.prepare(
      `INSERT INTO order_document_metadata(
        attachment_id,organization_id,order_id,document_category,description,public_to_customer,
        review_status,reviewed_by_user_id,reviewed_at,updated_at
       ) VALUES(?,?,?,?,?,0,'approved',NULL,?,?)`,
    ).bind(
      attachmentId,input.organizationId,input.orderId,placement.documentCode,
      orderDocumentTypeLabel(placement.documentCode),now,now,
    ),
  ]);
  await completeWorkflowSupplementTask({
    organizationId:input.organizationId,
    orderId:input.orderId,
    taskId:input.taskId,
    actorUserId:input.actorUserId,
    resolutionNote:"缺失文件已通过补录门户上传，系统自动销项。",
  });
  await env.DB.prepare(
    `UPDATE internal_notifications
     SET is_read=1,read_at=COALESCE(read_at,?)
     WHERE organization_id=? AND user_id=? AND category='order_document_supplement'
       AND link=? AND is_read=0`,
  ).bind(
    now,input.organizationId,task.salesperson_user_id ?? input.actorUserId,
    `/admin/orders/${encodeURIComponent(input.orderId)}?drawer=supplements`,
  ).run();
  return {attachmentId,documentCode:placement.documentCode};
}

async function supplementFileToDataUrl(file:File) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  let binary="";
  const chunkSize=0x8000;
  for (let index=0;index<bytes.length;index+=chunkSize) {
    binary+=String.fromCharCode(...bytes.subarray(index,index+chunkSize));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}
