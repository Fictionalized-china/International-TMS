import { env } from "cloudflare:workers";
import {
  syncCostsModuleStatus,
  syncOrderWorkflowSnapshot,
} from "./order-modules.server";

type QuoteReceivable = {
  id: string;
  quote_number: string;
  customer_name: string;
  currency: string;
  total_amount: number;
};

type QuoteCharge = {
  id: string;
  charge_code: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  exchange_rate: number;
};

export async function inheritAcceptedQuoteReceivables(
  organizationId: string,
  orderId: string,
  quotationId: string,
  actorUserId: string,
) {
  const quote = await env.DB.prepare(
    `SELECT q.id,q.quote_number,c.name AS customer_name,q.currency,q.total_amount
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id
      WHERE q.id=? AND q.organization_id=? AND q.status='accepted'`,
  )
    .bind(quotationId, organizationId)
    .first<QuoteReceivable>();
  if (!quote) throw new Error("报价无效或尚未接受");

  const charges = await env.DB.prepare(
    `SELECT id,charge_code,description,quantity,unit_price,amount,exchange_rate
       FROM quotation_charges
      WHERE quotation_id=?
      ORDER BY sort_order,id`,
  )
    .bind(quotationId)
    .all<QuoteCharge>();
  const now = new Date().toISOString();
  const statements = charges.results.map((charge) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO business_expenses(
         id,organization_id,order_id,direction,stage,charge_code,charge_name,
         counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
         base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
       ) VALUES(
         ?,?,?,'receivable','estimated',?,?,?,?,?,?,?,?,?,?,?,?,?,'quotation_charge',?
       )`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      orderId,
      charge.charge_code,
      charge.description,
      quote.customer_name,
      quote.currency,
      charge.quantity,
      charge.unit_price,
      charge.amount,
      charge.exchange_rate,
      charge.amount * charge.exchange_rate,
      `继承已接受报价 ${quote.quote_number}`,
      actorUserId,
      now,
      now,
      charge.id,
    ),
  );

  if (!statements.length) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO business_expenses(
           id,organization_id,order_id,direction,stage,charge_code,charge_name,
           counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
           base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
         ) VALUES(
           ?,?,?,'receivable','estimated','QUOTATION_TOTAL','报价应收',?,?,1,?,?,1,?,?,?,?,?,'quotation',?
         )`,
      ).bind(
        crypto.randomUUID(),
        organizationId,
        orderId,
        quote.customer_name,
        quote.currency,
        quote.total_amount,
        quote.total_amount,
        quote.total_amount,
        `继承已接受报价 ${quote.quote_number}`,
        actorUserId,
        now,
        now,
        quote.id,
      ),
    );
  }

  await env.DB.batch(statements);
  await syncCostsModuleStatus(organizationId, orderId, now);
  await syncOrderWorkflowSnapshot(organizationId, orderId);
}
