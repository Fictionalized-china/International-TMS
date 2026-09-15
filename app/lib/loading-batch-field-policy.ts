import type { WorkflowFieldMode } from "./workflow-field-catalog";

export const loadingBatchFieldDefinitions = {
  exit_port: "required",
  customs_location: "required",
  consolidation_warehouse: "required",
  main_carrier_id: "required",
  main_vehicle_type: "required",
  main_plate_number: "required",
  main_driver_name: "required",
  main_driver_phone: "required",
  planned_exit_at: "required",
  planned_arrival_at: "optional",
  loading_batch: "optional",
  route_code: "optional",
  loading_notes: "optional",
  planned_loading_at: "optional",
} as const satisfies Record<string, WorkflowFieldMode>;

export type LoadingBatchFieldKey = keyof typeof loadingBatchFieldDefinitions;

export type LoadingBatchWorkflowField = {
  fieldKey: string;
  isActive: boolean;
  isRequired: boolean;
};

export type LoadingBatchWorkflowOrder = {
  orderId: string;
  usesFrozenSnapshot?: boolean;
  currentStepKey?: string | null;
  appliesToCurrentOrFuture: boolean;
  loadingStageAvailable?: boolean;
  loadingTargetStepKey?: string | null;
  loadingTargetStepName?: string | null;
  loadingStageReason?: string | null;
  fields: readonly LoadingBatchWorkflowField[];
};

export type LoadingBatchStageGate = {
  available: boolean;
  targetStepKey: string | null;
  targetStepName: string | null;
  reason: string | null;
};

/**
 * A shared warehouse write is safe only when every mounted order is at its
 * own frozen loading node. Mixed custom step names are valid; mixed readiness
 * is not, because a partial dispatch would split one physical load operation.
 */
export function resolveLoadingBatchStageGate(
  orders: readonly LoadingBatchWorkflowOrder[],
  orderLabels: ReadonlyMap<string, string> = new Map(),
): LoadingBatchStageGate {
  const targetKeys = [...new Set(
    orders.map((order) => order.loadingTargetStepKey).filter(Boolean),
  )] as string[];
  const targetNames = [...new Set(
    orders.map((order) => order.loadingTargetStepName).filter(Boolean),
  )] as string[];
  if (!orders.length) {
    return {
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: "当前装车任务没有可核验的订单，不能继续办理",
    };
  }
  const blocked = orders.find((order) => order.loadingStageAvailable !== true);
  if (blocked) {
    const label = orderLabels.get(blocked.orderId)?.trim() || blocked.orderId;
    return {
      available: false,
      targetStepKey: targetKeys.length === 1 ? targetKeys[0] : null,
      targetStepName: targetNames.length ? targetNames.join(" / ") : null,
      reason: `${label}：${blocked.loadingStageReason ?? "无法确认冻结工作流的装车与出库办理节点，请刷新后重试"}`,
    };
  }
  return {
    available: true,
    targetStepKey: targetKeys.length === 1 ? targetKeys[0] : null,
    targetStepName: targetNames.length ? targetNames.join(" / ") : null,
    reason: null,
  };
}

export type LoadingBatchFieldPolicy = {
  isActive: boolean;
  isRequired: boolean;
  mode: WorkflowFieldMode;
};

export type LoadingBatchFieldPolicies = Record<LoadingBatchFieldKey, LoadingBatchFieldPolicy>;

const loadingBatchFieldAliases: Partial<Record<LoadingBatchFieldKey, readonly string[]>> = {
  main_carrier_id: ["overseas_carrier_name"],
  main_vehicle_type: ["overseas_vehicle_type", "overseas_vehicle_count"],
  main_plate_number: ["overseas_vehicle_plate"],
  main_driver_name: ["overseas_driver_name"],
  main_driver_phone: ["overseas_driver_phone"],
};

function policyForOrder(
  order: LoadingBatchWorkflowOrder,
  fieldKey: LoadingBatchFieldKey,
): LoadingBatchFieldPolicy | null {
  if (!order.appliesToCurrentOrFuture) return null;
  const semanticFieldKeys = new Set([fieldKey, ...(loadingBatchFieldAliases[fieldKey] ?? [])]);
  const configured = order.fields.filter((field) => semanticFieldKeys.has(field.fieldKey));
  if (configured.length) {
    const isRequired = configured.some((field) => field.isActive && field.isRequired);
    const isActive = isRequired || configured.some((field) => field.isActive);
    return {
      isActive,
      isRequired,
      mode: isRequired ? "required" : isActive ? "optional" : "hidden",
    };
  }
  if (order.usesFrozenSnapshot) return { isActive: false, isRequired: false, mode: "hidden" };
  const fallback = loadingBatchFieldDefinitions[fieldKey];
  return fallback === "required"
    ? { isActive: true, isRequired: true, mode: "required" }
    : fallback === "optional"
      ? { isActive: true, isRequired: false, mode: "optional" }
      : { isActive: false, isRequired: false, mode: "hidden" };
}

/**
 * A PZ batch is a shared business object. A required field on any participating
 * order therefore makes the batch field required. Optional wins only when no
 * participating order requires it; historical steps do not reopen old gates.
 */
export function resolveLoadingBatchFieldPolicies(
  orders: readonly LoadingBatchWorkflowOrder[],
): LoadingBatchFieldPolicies {
  return Object.fromEntries(
    (Object.keys(loadingBatchFieldDefinitions) as LoadingBatchFieldKey[]).map((fieldKey) => {
      const policies = orders
        .map((order) => policyForOrder(order, fieldKey))
        .filter((policy): policy is LoadingBatchFieldPolicy => Boolean(policy));
      const isRequired = policies.some((policy) => policy.isRequired);
      const isActive = isRequired || policies.some((policy) => policy.isActive);
      return [fieldKey, {
        isActive,
        isRequired,
        mode: isRequired ? "required" : isActive ? "optional" : "hidden",
      }];
    }),
  ) as LoadingBatchFieldPolicies;
}

export function loadingBatchResourcePolicy(policies: LoadingBatchFieldPolicies) {
  const vehicle = {
    isActive: policies.main_vehicle_type.isActive || policies.main_plate_number.isActive,
    isRequired: policies.main_vehicle_type.isRequired || policies.main_plate_number.isRequired,
  };
  const driver = {
    isActive: policies.main_driver_name.isActive || policies.main_driver_phone.isActive,
    isRequired: policies.main_driver_name.isRequired || policies.main_driver_phone.isRequired,
  };
  const carrier = {
    isActive: policies.main_carrier_id.isActive || vehicle.isActive || driver.isActive,
    isRequired: policies.main_carrier_id.isRequired || vehicle.isRequired || driver.isRequired,
  };
  return { carrier, vehicle, driver } as const;
}

export type LoadingDispatchPlanValues = {
  carrier_name?: string | null;
  vehicle_type?: string | null;
  vehicle_plate?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  planned_departure_at?: string | null;
  planned_arrival_at?: string | null;
};

const loadingDispatchPlanFields = [
  ["main_carrier_id", "出境承运商", "carrier_name"],
  ["main_vehicle_type", "出境车型", "vehicle_type"],
  ["main_plate_number", "出境车牌号", "vehicle_plate"],
  ["main_driver_name", "出境司机姓名", "driver_name"],
  ["main_driver_phone", "出境司机电话", "driver_phone"],
  ["planned_exit_at", "计划出境发车时间", "planned_departure_at"],
  ["planned_arrival_at", "计划境外到仓时间", "planned_arrival_at"],
] as const satisfies readonly (readonly [
  LoadingBatchFieldKey,
  string,
  keyof LoadingDispatchPlanValues,
])[];

/**
 * Separates workflow gates from informational gaps. Hidden fields disappear,
 * optional fields remain actionable without blocking, and only required fields
 * are returned as blockers.
 */
export function loadingDispatchPlanPolicyIssues(
  policies: LoadingBatchFieldPolicies,
  values: LoadingDispatchPlanValues,
) {
  const requiredMissing: string[] = [];
  const optionalMissing: Array<{ fieldKey: LoadingBatchFieldKey; label: string }> = [];
  for (const [fieldKey, label, valueKey] of loadingDispatchPlanFields) {
    const policy = policies[fieldKey];
    if (!policy.isActive || String(values[valueKey] ?? "").trim()) continue;
    if (policy.isRequired) requiredMissing.push(label);
    else optionalMissing.push({ fieldKey, label });
  }
  return { requiredMissing, optionalMissing };
}

export function loadingBatchRequiredValueError(
  policies: LoadingBatchFieldPolicies,
  values: Partial<Record<LoadingBatchFieldKey, string | null | undefined>>,
) {
  const labels: Partial<Record<LoadingBatchFieldKey, string>> = {
    exit_port: "出境口岸",
    customs_location: "清关地",
    planned_exit_at: "计划出境发车时间",
    planned_arrival_at: "计划境外到仓时间",
    route_code: "运输线路",
    loading_notes: "配载备注",
    planned_loading_at: "计划装车时间",
  };
  for (const fieldKey of Object.keys(labels) as LoadingBatchFieldKey[]) {
    if (policies[fieldKey].isRequired && !values[fieldKey]?.trim())
      return `请填写${labels[fieldKey]}`;
  }
  return "";
}
