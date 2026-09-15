import { env } from "cloudflare:workers";
import { createOrderFromAcceptedQuote, type CreatedOrder } from "./quote-order.server";
import { assertQuotationWorkflowFieldsComplete } from "./quotation-workflow-fields.server";

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
  accepted_at: string | null;
  withdrawn_at: string | null;
  withdrawn_by_user_id: string | null;
  acceptance_source: string | null;
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
  if (quote.lifecycle_status === "accepted") {
    if (quote.order_id && quote.order_number) {
      return { id: quote.order_id, orderNumber: quote.order_number, created: false };
    }
    await assertQuotationWorkflowFieldsComplete(input.organizationId,input.quotationId);
    return createOrderFromAcceptedQuote(input);
  }
  await assertQuotationWorkflowFieldsComplete(input.organizationId,input.quotationId);
  const previousLifecycle = quote.lifecycle_status;
  const now = new Date().toISOString();
  const transition = await env.DB.prepare(
    `UPDATE quotations
     SET lifecycle_status='accepted',status='accepted',accepted_at=COALESCE(accepted_at,?),
         withdrawn_at=NULL,withdrawn_by_user_id=NULL,acceptance_source=?,updated_at=?
     WHERE id=? AND organization_id=? AND lifecycle_status=?`,
  ).bind(now,input.source,now,input.quotationId,input.organizationId,previousLifecycle).run();
  if (!Number(transition.meta?.changes || 0)) {
    const raced = await existingOrderForQuote(input.organizationId,input.quotationId);
    if (raced) return { ...raced, created: false };
    return createOrderFromAcceptedQuote(input);
  }
  try {
    const created = await createOrderFromAcceptedQuote(input);
    await writeAudit({ ...input, action: "quotation.accept", resourceId: input.quotationId, metadata: { orderId: created.id, orderNumber: created.orderNumber, created: created.created } });
    return created;
  } catch (error) {
    const raced = await existingOrderForQuote(input.organizationId,input.quotationId);
    if (raced) {
      await writeAudit({ ...input, action: "quotation.accept", resourceId: input.quotationId, metadata: { orderId: raced.id, orderNumber: raced.orderNumber, created: false, recoveredFromRace: true } });
      return { ...raced, created: false };
    }
    await env.DB.prepare(
      `UPDATE quotations SET lifecycle_status=?,status=?,accepted_at=?,acceptance_source=?,
       withdrawn_at=?,withdrawn_by_user_id=?,updated_at=?
       WHERE id=? AND organization_id=? AND lifecycle_status='accepted' AND updated_at=?`,
    ).bind(
      previousLifecycle,
      legacyStatus(previousLifecycle),
      quote.accepted_at,
      quote.acceptance_source,
      quote.withdrawn_at,
      quote.withdrawn_by_user_id,
      new Date().toISOString(),
      input.quotationId,
      input.organizationId,
      now,
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
  const [,quotationResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE transport_orders SET quote_withdrawn=1,current_step_code='quote_withdrawn',
       current_step_name='报价接受已撤回',workflow_updated_at=?,updated_at=?
       WHERE id=? AND organization_id=? AND status='draft'
         AND current_step_code IN ('draft','order_creation')
         AND EXISTS(
           SELECT 1 FROM quotations q
           WHERE q.id=? AND q.organization_id=transport_orders.organization_id
             AND q.lifecycle_status='accepted'
         )`,
    ).bind(now,now,quote.order_id,input.organizationId,input.quotationId),
    env.DB.prepare(
      `UPDATE quotations SET lifecycle_status='withdrawn',status='expired',withdrawn_at=?,
       withdrawn_by_user_id=?,updated_at=? WHERE id=? AND organization_id=?
         AND lifecycle_status='accepted'
         AND EXISTS(
           SELECT 1 FROM transport_orders o
           WHERE o.id=? AND o.organization_id=quotations.organization_id
             AND o.status='draft' AND o.current_step_code='quote_withdrawn'
             AND o.workflow_updated_at=?
         )`,
    ).bind(now,input.actorUserId,now,input.quotationId,input.organizationId,quote.order_id,now),
  ]);
  if (!Number(quotationResult.meta?.changes || 0)) {
    throw new Error("报价已被其他人撤回或订单状态已经变化，请刷新后查看");
  }
  await env.DB.prepare(
    `INSERT INTO order_workflow_history(
      id,organization_id,order_id,action_code,action_name,from_status,to_status,
      from_step_code,to_step_code,actor_user_id,occurred_at
     ) VALUES(?,?,?,?,?,'draft','draft',?,'quote_withdrawn',?,?)`,
  ).bind(
    crypto.randomUUID(),input.organizationId,quote.order_id,"quote_acceptance_withdrawn","撤回报价接受",
    quote.current_step_code || "order_creation",input.actorUserId,now,
  ).run();
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
  const result = await env.DB.prepare(
    "UPDATE quotations SET lifecycle_status='void',status='cancelled',updated_at=? WHERE id=? AND organization_id=? AND lifecycle_status NOT IN ('accepted','void')",
  ).bind(new Date().toISOString(),input.quotationId,input.organizationId).run();
  if (!Number(result.meta?.changes || 0)) throw new Error("报价已作废或状态已经变化，请刷新后查看");
  await env.DB.prepare(
    `UPDATE workflow_instances SET status='cancelled',updated_at=?
     WHERE organization_id=? AND quotation_id=? AND order_id IS NULL`,
  ).bind(new Date().toISOString(),input.organizationId,input.quotationId).run();
  await writeAudit({ ...input, action: "quotation.void", resourceId: input.quotationId, metadata: {} });
}

async function loadQuote(organizationId: string, quotationId: string) {
  return env.DB.prepare(
    `SELECT q.id,q.quote_number,q.lifecycle_status,q.status,q.accepted_at,q.withdrawn_at,
      q.withdrawn_by_user_id,q.acceptance_source,
      o.id order_id,o.order_number,o.status order_status,o.current_step_code
     FROM quotations q
     LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
     WHERE q.id=? AND q.organization_id=? LIMIT 1`,
  ).bind(quotationId,organizationId).first<QuoteLifecycleRow>();
}

async function existingOrderForQuote(organizationId: string, quotationId: string) {
  const row = await env.DB.prepare(
    "SELECT id,order_number FROM transport_orders WHERE organization_id=? AND quotation_id=? LIMIT 1",
  ).bind(organizationId,quotationId).first<{ id: string; order_number: string }>();
  return row ? { id: row.id, orderNumber: row.order_number } : null;
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
