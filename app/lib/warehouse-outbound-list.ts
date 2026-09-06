export type WarehouseOutboundListFilters = {
  query: string;
  businessType: "all" | "ftl" | "ltl";
  readiness: "all" | "ready" | "blocked";
};

type FilterableLoadUnit = {
  order_number: string;
  batch_number: string;
  order_numbers: string;
  customer_name: string;
  customer_names: string;
  customer_identity_code: string;
  customer_identity_codes: string;
  destination_location: string;
  business_type: string;
  ready: boolean;
};

type IdentifiableLoadUnit = {
  id: string;
  transport_batch_id?: string | null;
};

export function normalizeWarehouseOutboundListFilters(
  searchParams: URLSearchParams,
): WarehouseOutboundListFilters {
  const businessType = searchParams.get("type");
  const readiness = searchParams.get("readiness");
  return {
    query: searchParams.get("q")?.trim() ?? "",
    businessType: businessType === "ftl" || businessType === "ltl" ? businessType : "all",
    readiness: readiness === "ready" || readiness === "blocked" ? readiness : "all",
  };
}

export function filterWarehouseOutboundLoadUnits<T extends FilterableLoadUnit>(
  units: T[],
  filters: WarehouseOutboundListFilters,
) {
  const query = filters.query.toLocaleLowerCase("zh-CN");
  return units.filter((unit) => {
    if (filters.businessType !== "all" && unit.business_type !== filters.businessType) return false;
    if (filters.readiness === "ready" && !unit.ready) return false;
    if (filters.readiness === "blocked" && unit.ready) return false;
    if (!query) return true;
    return [
      unit.order_number,
      unit.batch_number,
      unit.order_numbers,
      unit.customer_name,
      unit.customer_names,
      unit.customer_identity_code,
      unit.customer_identity_codes,
      unit.destination_location,
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(query));
  });
}

export function isConsolidatedOutboundTask(
  businessType: string,
  transportBatchId: string | null | undefined,
) {
  return businessType === "ltl" && Boolean(transportBatchId);
}

export function findWarehouseOutboundLoadUnit<T extends IdentifiableLoadUnit>(
  units: T[],
  requestedId: string | null | undefined,
) {
  if (!requestedId) return null;
  return units.find(
    (unit) => unit.id === requestedId || unit.transport_batch_id === requestedId,
  ) ?? null;
}

export function validateFtlOutboundResourceSelection(input: {
  carrierId: string;
  vehicleId: string;
  driverId: string;
  plannedDepartureAt: string;
  plannedArrivalAt: string;
  policies: {
    carrier: { isActive: boolean; isRequired: boolean };
    vehicle: { isActive: boolean; isRequired: boolean };
    driver: { isActive: boolean; isRequired: boolean };
    plannedDeparture: { isActive: boolean; isRequired: boolean };
    plannedArrival: { isActive: boolean; isRequired: boolean };
  };
}) {
  const hiddenSubmitted: string[] = [];
  if (!input.policies.carrier.isActive && input.carrierId.trim())
    hiddenSubmitted.push("境外承运商");
  if (!input.policies.vehicle.isActive && input.vehicleId.trim())
    hiddenSubmitted.push("出境车辆");
  if (!input.policies.driver.isActive && input.driverId.trim())
    hiddenSubmitted.push("出境司机");
  if (
    !input.policies.plannedDeparture.isActive &&
    input.plannedDepartureAt.trim()
  )
    hiddenSubmitted.push("计划出境发车时间");
  if (
    !input.policies.plannedArrival.isActive &&
    input.plannedArrivalAt.trim()
  )
    hiddenSubmitted.push("计划境外到仓时间");
  if (hiddenSubmitted.length)
    return `当前工作流已隐藏：${hiddenSubmitted.join("、")}，不能提交这些字段`;

  const missing: string[] = [];
  if (input.policies.carrier.isRequired && !input.carrierId.trim())
    missing.push("境外承运商");
  if (input.policies.vehicle.isRequired && !input.vehicleId.trim())
    missing.push("出境车辆");
  if (input.policies.driver.isRequired && !input.driverId.trim())
    missing.push("出境司机");
  if (
    input.policies.plannedDeparture.isRequired &&
    !input.plannedDepartureAt.trim()
  )
    missing.push("计划出境发车时间");
  if (
    input.policies.plannedArrival.isRequired &&
    !input.plannedArrivalAt.trim()
  )
    missing.push("计划境外到仓时间");
  return missing.length
    ? `请由仓库确认工作流必填项：${missing.join("、")}`
    : null;
}

export function validateFtlOutboundRouteFields(input: {
  exitPort: string;
  customsLocation: string;
  policies: {
    exit_port: { isRequired: boolean };
    customs_location: { isRequired: boolean };
  };
}) {
  const missing: string[] = [];
  if (input.policies.exit_port.isRequired && !input.exitPort.trim()) missing.push("出境口岸");
  if (input.policies.customs_location.isRequired && !input.customsLocation.trim()) missing.push("起运地清关地");
  return missing.length ? `请补齐工作流必填项：${missing.join("、")}` : null;
}

export function validateFtlOutboundRouteSubmission(input: {
  exitPort: string;
  customsLocation: string;
  policies: {
    exit_port: { isActive: boolean };
    customs_location: { isActive: boolean };
  };
}) {
  if (!input.policies.exit_port.isActive && input.exitPort.trim())
    return "当前工作流已隐藏出境口岸，不能在此登记";
  if (!input.policies.customs_location.isActive && input.customsLocation.trim())
    return "当前工作流已隐藏起运地清关地，不能在此登记";
  return null;
}
