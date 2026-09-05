import type { WorkflowFieldState } from "./workflow-fields.server";

export type CostsCompletionFieldState = Pick<
  WorkflowFieldState,
  | "moduleCode"
  | "stepKey"
  | "fieldKey"
  | "label"
  | "isActive"
  | "isRequired"
  | "present"
>;

export type CostsCompletionDirectionState = {
  direction: "receivable" | "payable";
  hasExpenses: boolean;
  customerServiceConfirmed: boolean;
  businessReviewed: boolean;
  financeReviewed: boolean;
};

export type CostsCompletionBlocker = {
  fieldKey: string;
  label: string;
  direction?: CostsCompletionDirectionState["direction"];
};

export type CostsCompletionGateResult = {
  complete: boolean;
  status: "not_started" | "in_progress" | "completed";
  progressPercent: number;
  currentStepCode: "waiting" | "parallel_review" | "settled";
  blockingReason: string | null;
  blockers: CostsCompletionBlocker[];
};

const signOffFieldChecks = {
  customer_service_confirmation: "customerServiceConfirmed",
  business_review: "businessReviewed",
  finance_review: "financeReviewed",
} as const satisfies Record<
  string,
  keyof Pick<
    CostsCompletionDirectionState,
    "customerServiceConfirmed" | "businessReviewed" | "financeReviewed"
  >
>;

function directionLabel(direction: CostsCompletionDirectionState["direction"]) {
  return direction === "receivable" ? "应收" : "应付";
}

export function evaluateCostsCompletionGate(input: {
  fields: readonly CostsCompletionFieldState[];
  directions: readonly CostsCompletionDirectionState[];
}): CostsCompletionGateResult {
  const requiredFields = input.fields.filter(
    (field) =>
      field.moduleCode === "costs" &&
      field.stepKey === "reconciliation" &&
      field.isActive &&
      field.isRequired,
  );
  const directionByCode = new Map(
    input.directions.map((direction) => [direction.direction, direction]),
  );
  const blockers: CostsCompletionBlocker[] = [];
  let requiredCheckCount = 0;
  let completedRequiredCheckCount = 0;
  for (const field of requiredFields) {
    const check = signOffFieldChecks[field.fieldKey as keyof typeof signOffFieldChecks];
    if (!check) {
      requiredCheckCount += 1;
      if (field.present) completedRequiredCheckCount += 1;
      else blockers.push({ fieldKey: field.fieldKey, label: field.label });
      continue;
    }
    for (const direction of ["receivable", "payable"] as const) {
      requiredCheckCount += 1;
      if (directionByCode.get(direction)?.[check]) {
        completedRequiredCheckCount += 1;
      } else {
        blockers.push({
          fieldKey: field.fieldKey,
          label: `${field.label}（${directionLabel(direction)}）`,
          direction,
        });
      }
    }
  }
  const complete = blockers.length === 0;
  const hasActivity = input.directions.some(
    (direction) =>
      direction.hasExpenses ||
      direction.customerServiceConfirmed ||
      direction.businessReviewed ||
      direction.financeReviewed,
  ) || input.fields.some((field) => field.present);

  return {
    complete,
    status: complete ? "completed" : hasActivity ? "in_progress" : "not_started",
    progressPercent: complete
      ? 100
      : Math.min(
          99,
          Math.round((completedRequiredCheckCount / Math.max(1, requiredCheckCount)) * 100),
        ),
    currentStepCode: complete ? "settled" : hasActivity ? "parallel_review" : "waiting",
    blockingReason: blockers.length
      ? `待补齐必填项：${blockers.map((blocker) => blocker.label).join("、")}`
      : null,
    blockers,
  };
}
