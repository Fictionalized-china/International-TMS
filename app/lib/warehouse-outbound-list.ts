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

export function validateFtlOutboundResourceSelection(input: {
  carrierId: string;
  vehicleId: string;
  driverId: string;
  plannedDepartureAt: string;
}) {
  const missing: string[] = [];
  if (!input.carrierId.trim()) missing.push("境外承运商");
  if (!input.vehicleId.trim()) missing.push("出境车辆");
  if (!input.driverId.trim()) missing.push("出境司机");
  if (!input.plannedDepartureAt.trim()) missing.push("计划出境发车时间");
  return missing.length ? `请由仓库确认：${missing.join("、")}` : null;
}
