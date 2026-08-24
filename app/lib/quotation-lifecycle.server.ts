import { env } from "cloudflare:workers";
import { createOrderFromAcceptedQuote, type CreatedOrder } from "./quote-order.server";

type LifecycleStatus = "pending" | "accepted" | "withdrawn" | "void";

type QuoteLifecycleRow = {
  id: string;
  quote_number: string;
  lifecycle_status: LifecycleStatus;
  status: string;
  order_id: string | null;
  order_number: string | null;
  order_status: string | null;
  current_step_code: string | null;
};

export async function acceptQuotation(input: {
  organizationId: string;
  quotationId: string;
  actorUserId: string;
  source: "admin" | "portal";
  request?: Request;
}): Promise<CreatedOrder> {
  const quote = await loadQuote(input.organizationId, input.quotationId);
  if (!quote) throw new Error("报价不存在");
  if (quote.lifecycle_status === "void") throw new Error("已作废报价不能接受");
  const previousLifecycle = quote.lifecycle_status;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE quotations
     SET lifecycle_status='accepted',status='accepted',accepted_at=COALESCE(accepted_at,?),
         withdrawn_at=NULL,withdrawn_by_user_id=NULL,acceptance_source=?,updated_at=?
     WHERE id=? AND organization_id=? AND lifecycle_status IN ('pending','withdrawn','accepted')`,
  ).bind(now,input.source,now,input.quotationId,input.organizationId).run();
  try {
    const created = await createOrderFromAcceptedQuote(input);
    await writeAudit({ ...input, action: "quotation.accept", resourceId: input.quotationId, metadata: { orderId: created.id, orderNumber: created.orderNumber, created: created.created } });
    return created;
  } catch (error) {
    await env.DB.prepare(
      `UPDATE quotations SET lifecycle_status=?,status=?,accepted_at=CASE WHEN ?='accepted' THEN accepted_at ELSE NULL END,
       acceptance_source=CASE WHEN ?='accepted' THEN acceptance_source ELSE NULL END,updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(
      previousLifecycle,
      legacyStatus(previousLifecycle),
      previousLifecycle,
      previousLifecycle,
      new Date().toISOString(),
      input.quotationId,
      input.organizationId,
    ).run();
    throw error;
  }
}

export async function withdrawQuotationAcceptance(input: {
  organizationId: string;
  quotationId: string;
  actorUserId: string;
  source: "admin" | "portal";
}) {
  const quote = await loadQuote(input.organizationId, input.quotationId);
  if (!quote || quote.lifecycle_status !== "accepted") throw new Error("仅已接受报价可以撤回");
  if (!quote.order_id || !quote.order_status) throw new Error("报价未关联订单");
  if (quote.order_status !== "draft" || !["draft","order_creation"].includes(quote.current_step_code || "")) {
    throw new Error("订单已提交审批，不能撤回报价；请在订单中发起变更或取消");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE quotations SET lifecycle_status='withdrawn',status='expired',withdrawn_at=?,
       withdrawn_by_user_id=?,updated_at=? WHERE id=? AND organization_id=?`,
    ).bind(now,input.actorUserId,now,input.quotationId,input.organizationId),
    env.DB.prepare(
      `UPDATE transport_orders SET quote_withdrawn=1,current_step_code='quote_withdrawn',
       current_step_name='报价接受已撤回',workflow_updated_at=?,updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(now,now,quote.order_id,input.organizationId),
    env.DB.prepare(
      `INSERT INTO order_workflow_history(
        id,organization_id,order_id,action_code,action_name,from_status,to_status,
        from_step_code,to_step_code,actor_user_id,occurred_at
       ) VALUES(?,?,?,?,?,'draft','draft',?,'quote_withdrawn',?,?)`,
    ).bind(
      crypto.randomUUID(),input.organizationId,quote.order_id,"quote_acceptance_withdrawn","撤回报价接受",
      quote.current_step_code || "order_creation",input.actorUserId,now,
    ),
  ]);
  await writeAudit({ ...input, action: "quotation.withdraw", resourceId: input.quotationId, metadata: { orderId: quote.order_id } });
  return { orderId: quote.order_id, orderNumber: quote.order_number };
}

export async function voidQuotation(input: {
  organizationId: string;
  quotationId: string;
  actorUserId: string;
  source: "admin" | "portal";
}) {
  const quote = await loadQuote(input.organizationId, input.quotationId);
  if (!quote) throw new Error("报价不存在");
  if (quote.lifecycle_status === "accepted") throw new Error("已接受报价请先撤回，不能直接作废");
  await env.DB.prepare(
    "UPDATE quotations SET lifecycle_status='void',status='cancelled',updated_at=? WHERE id=? AND organization_id=?",
  ).bind(new Date().toISOString(),input.quotationId,input.organizationId).run();
  await writeAudit({ ...input, action: "quotation.void", resourceId: input.quotationId, metadata: {} });
}

async function loadQuote(organizationId: string, quotationId: string) {
  return env.DB.prepare(
    `SELECT q.id,q.quote_number,q.lifecycle_status,q.status,
      o.id order_id,o.order_number,o.status order_status,o.current_step_code
     FROM quotations q
     LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
     WHERE q.id=? AND q.organization_id=? LIMIT 1`,
  ).bind(quotationId,organizationId).first<QuoteLifecycleRow>();
}

function legacyStatus(status: LifecycleStatus) {
  if (status === "accepted") return "accepted";
  if (status === "withdrawn") return "expired";
  if (status === "void") return "cancelled";
  return "sent";
}

async function writeAudit(input: {
  organizationId: string;
  actorUserId: string;
  action: string;
  resourceId: string;
  source: "admin" | "portal";
  metadata: Record<string, unknown>;
}) {
  await env.DB.prepare(
    `INSERT INTO audit_logs(
      id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at
     ) VALUES(?,?,?,?,?,?,'success',?,?)`,
  ).bind(
    crypto.randomUUID(),input.organizationId,input.actorUserId,input.action,"quotation",input.resourceId,
    JSON.stringify({ source: input.source, ...input.metadata }),new Date().toISOString(),
  ).run();
}
