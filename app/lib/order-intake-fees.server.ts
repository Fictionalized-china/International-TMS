import { env } from "cloudflare:workers";
import { missingOrderIntakeFees } from "./order-intake-fees";

export async function loadMissingOrderIntakeFees(input: {
  organizationId: string;
  orderId: string;
  businessType: string;
}) {
  const result = await env.DB.prepare(
    `SELECT charge_code,charge_name,amount
       FROM business_expenses
      WHERE organization_id=? AND order_id=? AND stage!='cancelled'`,
  ).bind(input.organizationId, input.orderId).all<{
    charge_code: string;
    charge_name: string;
    amount: number;
  }>();
  return missingOrderIntakeFees(input.businessType, result.results.map((row) => ({
    chargeCode: row.charge_code,
    chargeName: row.charge_name,
    amount: Number(row.amount),
  })));
}
