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
  outstandingBalance?: number;
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

const balanceFieldKeys = new Set(["cash_records", "writeoff_records"]);

function directionLabel(direction: CostsCompletionDirectionState["direction"]) {
  return direction === "receivable" ? "应收" : "应付";
}

export function evaluateCostsCompletionGate(input: {
  fields: readonly CostsCompletionFieldState[];
  directions: readonly CostsCompletionDirectionState[];
  settlementStageReached?: boolean;
}): CostsCompletionGateResult {
  const requiredFields = input.fields.filter((field) => {
    if (field.moduleCode !== "costs" || !field.isActive) return false;
    // The three settlement signatures are business controls, not ordinary
    // optional data fields.  If enabled, all applicable directions must be
    // signed even when an older workflow version marked the field optional.
    return field.isRequired || field.fieldKey in signOffFieldChecks;
  });
  const directionByCode = new Map(
    input.directions.map((direction) => [direction.direction, direction]),
  );
  const blockers: CostsCompletionBlocker[] = [];
  let requiredCheckCount = 0;
  let completedRequiredCheckCount = 0;
  const requiredBalanceFields = requiredFields.filter((field) =>
    balanceFieldKeys.has(field.fieldKey),
  );
  const hasBalanceFacts = input.directions.some(
    (direction) => direction.outstandingBalance !== undefined,
  );
  for (const field of requiredFields) {
    if (hasBalanceFacts && balanceFieldKeys.has(field.fieldKey)) continue;
    const check =
      signOffFieldChecks[field.fieldKey as keyof typeof signOffFieldChecks];
    if (!check) {
      requiredCheckCount += 1;
      if (field.present) completedRequiredCheckCount += 1;
      else blockers.push({ fieldKey: field.fieldKey, label: field.label });
      continue;
    }
    for (const direction of ["receivable", "payable"] as const) {
      const directionState = directionByCode.get(direction);
      if (!directionState?.hasExpenses) continue;
      requiredCheckCount += 1;
      if (directionState[check]) {
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
  if (hasBalanceFacts && requiredBalanceFields.length) {
    const balanceLabel = requiredBalanceFields
      .map((field) => field.label)
      .join("、");
    for (const direction of input.directions) {
      if (!direction.hasExpenses) continue;
      requiredCheckCount += 1;
      if (
        direction.outstandingBalance !== undefined &&
        direction.outstandingBalance <= 0.009
      ) {
        completedRequiredCheckCount += 1;
      } else {
        blockers.push({
          fieldKey: requiredBalanceFields[0].fieldKey,
          label: `${balanceLabel}（${directionLabel(direction.direction)}未结清）`,
          direction: direction.direction,
        });
      }
    }
  }
  const settlementStageReached = input.settlementStageReached ?? true;
  if (!settlementStageReached) {
    blockers.push({
      fieldKey: "settlement_stage",
      label: "尚未进入对账结算节点",
    });
  }
  const complete = blockers.length === 0;
  const hasActivity =
    input.directions.some(
      (direction) =>
        direction.hasExpenses ||
        direction.customerServiceConfirmed ||
        direction.businessReviewed ||
        direction.financeReviewed,
    ) || input.fields.some((field) => field.present);

  return {
    complete,
    status: complete
      ? "completed"
      : hasActivity
        ? "in_progress"
        : "not_started",
    progressPercent: complete
      ? 100
      : Math.min(
          99,
          Math.round(
            (completedRequiredCheckCount / Math.max(1, requiredCheckCount)) *
              100,
          ),
        ),
    currentStepCode: complete
      ? "settled"
      : hasActivity
        ? "parallel_review"
        : "waiting",
    blockingReason: blockers.length
      ? `待补齐必填项：${blockers.map((blocker) => blocker.label).join("、")}`
      : null,
    blockers,
  };
}
