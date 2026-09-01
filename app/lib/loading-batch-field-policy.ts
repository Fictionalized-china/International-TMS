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
  appliesToCurrentOrFuture: boolean;
  fields: readonly LoadingBatchWorkflowField[];
};

export type LoadingBatchFieldPolicy = {
  isActive: boolean;
  isRequired: boolean;
  mode: WorkflowFieldMode;
};

export type LoadingBatchFieldPolicies = Record<LoadingBatchFieldKey, LoadingBatchFieldPolicy>;

function policyForOrder(
  order: LoadingBatchWorkflowOrder,
  fieldKey: LoadingBatchFieldKey,
): LoadingBatchFieldPolicy | null {
  if (!order.appliesToCurrentOrFuture) return null;
  const configured = order.fields.find((field) => field.fieldKey === fieldKey);
  if (configured) {
    if (!configured.isActive) return { isActive: false, isRequired: false, mode: "hidden" };
    if (configured.isRequired) return { isActive: true, isRequired: true, mode: "required" };
    return { isActive: true, isRequired: false, mode: "optional" };
  }
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
