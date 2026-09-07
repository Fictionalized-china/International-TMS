export type CustomsWorkflowFieldPolicy = {
  fieldKey: string;
  isActive: boolean;
  isRequired: boolean;
};

export type CustomsModuleAutomationState = {
  status: "in_progress" | "completed";
  step: "documents" | "declared" | "review" | "released";
  name: string;
  progress: number;
  blocker: string | null;
};

const declarationFieldKeys = new Set([
  "customs_declarations",
  "declaration_stage",
  "declaration_status",
  "declaration_number",
  "declaration_type",
  "declaration_title",
  "declaring_company",
  "declaration_date",
  "declaration_amount",
  "declaration_currency",
  "declaration_gross_weight",
]);

export function customsModuleGateRequirements(
  fields: readonly CustomsWorkflowFieldPolicy[],
  options?: { moduleRequired?: boolean },
) {
  // Empty snapshots are legacy orders and retain the historical safe baseline.
  const legacy = fields.length === 0;
  if (options?.moduleRequired === false) {
    return { declarationsRequired: false, releaseRequired: false };
  }
  const declarationField = fields.find(
    (field) => field.fieldKey === "customs_declarations",
  );
  const releaseField = fields.find((field) => field.fieldKey === "customs_release");
  if (options?.moduleRequired === true) {
    return {
      declarationsRequired: legacy || declarationField?.isActive === true,
      releaseRequired: legacy || releaseField?.isActive === true,
    };
  }
  const declarationsRequired = legacy || fields.some(
    (field) =>
      declarationFieldKeys.has(field.fieldKey) &&
      field.isActive &&
      field.isRequired,
  );
  const releaseRequired = releaseField
    ? releaseField.isActive && releaseField.isRequired
    : legacy;
  return { declarationsRequired, releaseRequired };
}

/**
 * Derives the automatic customs-module state from the effective workflow
 * snapshot. A required module must produce every visible core result, while
 * an optional module never blocks and hidden core actions stay absent.
 */
export function deriveCustomsModuleAutomationState(input: {
  total: number;
  released: number;
  fields: readonly CustomsWorkflowFieldPolicy[];
  moduleRequired?: boolean;
}): CustomsModuleAutomationState {
  const total = Math.max(0, Number(input.total || 0));
  const released = Math.max(0, Math.min(total, Number(input.released || 0)));
  const pending = total - released;
  const { declarationsRequired, releaseRequired } = customsModuleGateRequirements(
    input.fields,
    { moduleRequired: input.moduleRequired },
  );

  if ((declarationsRequired || releaseRequired) && total === 0) {
    return {
      status: "in_progress",
      step: "documents",
      name: "等待申报单",
      progress: 20,
      blocker: "尚未录入有效起运地报关单",
    };
  }
  if (releaseRequired && pending > 0) {
    return {
      status: "in_progress",
      step: "review",
      name: `海关审核（${released}/${total}）`,
      progress: 80,
      blocker: `还有 ${pending} 张有效起运地报关单未放行`,
    };
  }
  if (releaseRequired) {
    return {
      status: "completed",
      step: "released",
      name: "全部申报单已放行",
      progress: 100,
      blocker: null,
    };
  }
  if (declarationsRequired) {
    return {
      status: "completed",
      step: "declared",
      name: "必需申报单已登记，放行为非必填",
      progress: 100,
      blocker: null,
    };
  }
  return {
    status: "completed",
    step: total > 0 ? "declared" : "documents",
    name: total > 0 ? "选填报关信息已登记" : "当前工作流无报关必填门禁",
    progress: 100,
    blocker: null,
  };
}
