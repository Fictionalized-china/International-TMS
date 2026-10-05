import type { IntakePayable } from './intake-fee-lines';

export function intakePayableStatements(db: Pick<D1Database,'prepare'>, input: {
  organizationId: string; orderId: string; quotationId: string; actorUserId: string; now: string;
  fees: readonly IntakePayable[];
}) {
  return input.fees.map((fee,index) => db.prepare(`INSERT INTO business_expenses(
    id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,
    currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,
    created_by_user_id,created_at,updated_at,source_type,source_id)
    VALUES(?,?,?,'payable','estimated',?,?,?,'CNY',?,?,?,1,?,?,?,?,?,'direct_order_entry',?)`)
    .bind(crypto.randomUUID(),input.organizationId,input.orderId,fee.chargeCode,fee.chargeName,
      fee.counterparty,fee.quantity??1,fee.unitPrice??fee.amount,fee.amount,fee.amount,
      fee.notes??null,input.actorUserId,input.now,input.now,`${input.quotationId}:${index+1}:${fee.chargeCode}`));
}
