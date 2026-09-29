export type OrderIntakeExpense = {
  chargeCode: string;
  chargeName: string;
  amount: number;
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
  { code: "customs_port", label: "报关/口岸费", aliases: [/CUSTOMS/i, /PORT/i, /报关/, /口岸/] },
  { code: "overseas_driver", label: "境外司机费", aliases: [/OVERSEAS_DRIVER/i, /FOREIGN_DRIVER/i, /境外司机/] },
  { code: "transit_customs", label: "转关费", aliases: [/TRANSIT_CUSTOMS/i, /转关/] },
] as const;

export const ltlOrderIntakeFeeRequirements: readonly OrderIntakeFeeRequirement[] = [
  ftlOrderIntakeFeeRequirements[0],
] as const;

export function missingOrderIntakeFees(
  businessType: string,
  expenses: ReadonlyArray<OrderIntakeExpense>,
) {
  const requirements = businessType === "ftl"
    ? ftlOrderIntakeFeeRequirements
    : ltlOrderIntakeFeeRequirements;
  return requirements.filter((requirement) => !expenses.some((expense) => {
    const searchable = `${expense.chargeCode} ${expense.chargeName}`.trim();
    // An explicit zero is valid (for example customer self-delivery). The
    // presence of a real expense row is the business confirmation.
    return Number.isFinite(Number(expense.amount)) &&
      requirement.aliases.some((alias) => alias.test(searchable));
  }));
}
