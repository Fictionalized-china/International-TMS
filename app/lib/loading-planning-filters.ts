export type LoadingPlanningFilters = {
  q: string;
  warehouseId: string;
  destinationWarehouseId: string;
  customer: string;
  destination: string;
  port: string;
};

export const emptyLoadingPlanningFilters: LoadingPlanningFilters = {
  q: "", warehouseId: "", destinationWarehouseId: "", customer: "", destination: "", port: "",
};

type PlanningSearchRow = {
  order_id: string; order_number: string; customer_name: string;
  cargo_description: string | null; cargo_names: string | null;
  warehouse_id: string; overseas_warehouse_id: string | null;
  destination_country: string; destination_state: string | null; destination_city: string;
  exit_port: string | null; exit_port_name: string | null;
};

/** Filters only the already-authorized, ready-to-load pool; never broadens it. */
export function filterLoadingPlanningCandidates<T extends PlanningSearchRow>(rows: readonly T[], filters: LoadingPlanningFilters): T[] {
  const contains = (value: unknown, query: string) => String(value ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  return rows.filter(row =>
    (!filters.warehouseId || row.warehouse_id === filters.warehouseId) &&
    (!filters.destinationWarehouseId || row.overseas_warehouse_id === filters.destinationWarehouseId) &&
    contains(row.customer_name, filters.customer) &&
    contains([row.order_number, row.cargo_description, row.cargo_names].join(" "), filters.q) &&
    contains([row.destination_country, row.destination_state, row.destination_city].join(" "), filters.destination) &&
    contains([row.exit_port, row.exit_port_name].join(" "), filters.port),
  );
}

/** Selected orders remain submitted when a later filter hides their rows. */
export function hiddenLoadingPlanningSelections<T extends { order_id: string }>(selected: readonly T[], visible: readonly T[]) {
  const visibleIds = new Set(visible.map(row => row.order_id));
  return selected.filter(row => !visibleIds.has(row.order_id));
}
