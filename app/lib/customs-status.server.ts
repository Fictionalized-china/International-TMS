import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";
import { deriveCustomsModuleAutomationState } from "./customs-module-policy";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";

export async function syncCustomsModuleFromRecords(
  organizationId: string,
  orderId: string,
  actorUserId: string,
) {
  const now = new Date().toISOString();
  const records = await env.DB.prepare(
    "SELECT id FROM order_customs_records WHERE organization_id=? AND order_id=?",
  ).bind(organizationId, orderId).all<{ id: string }>();
  const recordUpdates: D1PreparedStatement[] = [];
  for (const record of records.results) {
    const aggregate = await env.DB.prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='released' THEN 1 ELSE 0 END) released,
              MIN(declared_at) declared_at,MAX(released_at) released_at,
              MAX(is_inspected) inspected
       FROM order_customs_declarations
       WHERE customs_record_id=? AND organization_id=? AND order_id=?
         AND is_deleted=0 AND status!='cancelled'`,
    ).bind(record.id, organizationId, orderId).first<{
      total: number;
      released: number | null;
      declared_at: string | null;
      released_at: string | null;
      inspected: number | null;
    }>();
    const latestDeclaration = await env.DB.prepare(
      `SELECT declaration_number,declaration_type
       FROM order_customs_declarations
       WHERE customs_record_id=? AND organization_id=? AND order_id=?
         AND is_deleted=0 AND status!='cancelled'
       ORDER BY updated_at DESC LIMIT 1`,
    ).bind(record.id, organizationId, orderId).first<{
      declaration_number: string;
      declaration_type: string;
    }>();
    const total = aggregate?.total ?? 0;
    const released = aggregate?.released ?? 0;
    const status = total === 0 ? "draft" : released === total ? "released" : "declared";
    recordUpdates.push(
      env.DB.prepare(
        `UPDATE order_customs_records
         SET declaration_number=?,declaration_type=?,declared_at=?,released_at=?,
           inspection_required=?,status=?,updated_at=?
         WHERE id=? AND organization_id=? AND order_id=?`,
      ).bind(
        latestDeclaration?.declaration_number ?? null,
        latestDeclaration?.declaration_type ?? null,
        aggregate?.declared_at ?? null,
        status === "released" ? aggregate?.released_at ?? null : null,
        aggregate?.inspected ?? 0,
        status,
        now,
        record.id,
        organizationId,
        orderId,
      ),
    );
  }
  if (recordUpdates.length) await env.DB.batch(recordUpdates);

  const gate = await env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END) released
     FROM order_customs_declarations d
     JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
     WHERE d.organization_id=? AND d.order_id=? AND r.clearance_stage='origin'
       AND d.is_deleted=0 AND d.status!='cancelled'`,
  ).bind(organizationId, orderId).first<{ total: number; released: number | null }>();
  const total = gate?.total ?? 0;
  const released = gate?.released ?? 0;
  const configuredFields = await loadOrderModuleWorkflowFields(
    organizationId,
    orderId,
    "customs",
  );
  const next = deriveCustomsModuleAutomationState({
    total,
    released,
    fields: configuredFields,
  });
  const module = await env.DB.prepare(
    "SELECT id,status,current_step_code,current_step_name,progress_percent,blocking_reason FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='customs' AND enabled=1",
  ).bind(organizationId, orderId).first<{
    id: string;
    status: string;
    current_step_code: string | null;
    current_step_name: string | null;
    progress_percent: number;
    blocking_reason: string | null;
  }>();
  if (!module) {
    await syncOrderWorkflowSnapshot(organizationId, orderId);
    return;
  }
  const changed = module.status !== next.status || module.current_step_code !== next.step || module.current_step_name !== next.name || module.progress_percent !== next.progress || module.blocking_reason !== next.blocker;
  if (changed) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=?,
           started_at=COALESCE(started_at,?),completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,updated_at=?
         WHERE id=?`,
      ).bind(next.status,next.step,next.name,next.progress,next.blocker,now,next.status,now,now,module.id),
      env.DB.prepare(
        "INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),organizationId,orderId,module.id,"customs_declarations_sync","申报单门禁自动同步",
        module.current_step_code,next.step,next.name,actorUserId,
        next.blocker ?? next.name,now,
      ),
    ]);
  }
  await syncOrderWorkflowSnapshot(organizationId, orderId);
}
