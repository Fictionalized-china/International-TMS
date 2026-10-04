import { env } from "cloudflare:workers";
import { missingOrderIntakeFees } from "./order-intake-fees";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";

export async function loadMissingOrderIntakeFees(input: {
  organizationId: string;
  orderId: string;
  businessType: string;
}) {
  const result = await env.DB.prepare(
    `SELECT charge_code,charge_name,amount,direction
       FROM business_expenses
      WHERE organization_id=? AND order_id=? AND stage!='cancelled'`,
  ).bind(input.organizationId, input.orderId).all<{
    charge_code: string;
    charge_name: string;
    amount: number;
    direction: "receivable" | "payable";
  }>();
  return missingOrderIntakeFees(input.businessType, result.results.map((row) => ({
    chargeCode: row.charge_code,
    chargeName: row.charge_name,
    amount: Number(row.amount),
    direction: row.direction,
  })), await loadBusinessProcessPolicy(input.organizationId));
}
