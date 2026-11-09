import { policyEnabled, type BusinessProcessPolicy } from "./business-process-policy";

export type OrderIntakeExpense = {
  chargeCode: string;
  chargeName: string;
  amount: number;
  direction?: "receivable" | "payable";
};

export type OrderIntakeFeeRequirement = {
  code: string;
  label: string;
  aliases: readonly RegExp[];
};

export const ftlOrderIntakeFeeRequirements: readonly OrderIntakeFeeRequirement[] = [
  { code: "pickup", label: "提货费", aliases: [/PICKUP/i, /提货/] },
  { code: "handling", label: "装卸费", aliases: [/HANDLING/i, /装卸/] },
  { code: "storage", label: "仓储费", aliases: [/STORAGE/i, /WAREHOUSE/i, /仓储/] },
  { code: "customs_port", label: "报关/口岸费", aliases: [/^CUSTOMS(?:\s|$)/i, /^PORT(?:\s|$)/i, /报关/, /口岸/] },
  { code: "overseas_driver", label: "境外司机费", aliases: [/OVERSEAS_DRIVER/i, /FOREIGN_DRIVER/i, /境外司机/] },
  { code: "transit_customs", label: "转关费", aliases: [/TRANSIT_CUSTOMS/i, /转关/] },
] as const;

export const ltlOrderIntakeFeeRequirements: readonly OrderIntakeFeeRequirement[] = [
  ftlOrderIntakeFeeRequirements[0],
] as const;

export function configuredOrderIntakeFees(policy: BusinessProcessPolicy, businessType: string) {
  return policy[businessType === "ftl" ? "order.ftl_required_fees" : "order.ltl_required_fees"].split(",").filter(Boolean)
    .map(code => ftlOrderIntakeFeeRequirements.find(r => r.code === code) ?? { code, label: code, aliases: [] });
}

export function missingOrderIntakeFees(
  businessType: string,
  expenses: ReadonlyArray<OrderIntakeExpense>,
  policy?: BusinessProcessPolicy,
) {
  const defaults = businessType === "ftl"
    ? ftlOrderIntakeFeeRequirements
    : ltlOrderIntakeFeeRequirements;
  const requirements = policy ? configuredOrderIntakeFees(policy, businessType) : defaults;
  const missing = requirements.filter((requirement) => !expenses.some((expense) => {
    const searchable = `${expense.chargeCode} ${expense.chargeName}`.trim();
    // An explicit zero is valid (for example customer self-delivery). The
    // presence of a real expense row is the business confirmation.
    return expense.direction === "payable" && Number.isFinite(expense.amount) && expense.amount >= 0 &&
      (expense.chargeCode === requirement.code || requirement.aliases.some((alias) => alias.test(searchable)));
  }));
  if (policy) {
    const valid = expenses.filter(e => Number.isFinite(e.amount) && e.amount >= 0);
    if (policyEnabled(policy, "order.require_receivable") && !valid.some(e => e.direction === "receivable")) missing.push({ code: "receivable", label: "客户应收费用", aliases: [] });
    if (businessType === "ftl" && policyEnabled(policy, "order.ftl_require_payable") && !valid.some(e => e.direction === "payable")) missing.push({ code: "payable", label: "供应商应付费用", aliases: [] });
  }
  return missing;
}
