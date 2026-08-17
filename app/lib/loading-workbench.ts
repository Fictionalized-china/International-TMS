export const loadingFilterFields = {
  customer: "customer_name",
  origin: "origin_label",
  carrier: "carrier_name",
  work_number: "work_number",
  warehouse: "warehouse_name",
  destination: "destination_label",
  operating_company: "operating_company",
  document_owner: "document_owner",
  customer_service: "customer_service",
  business_owner: "business_owner",
} as const;

export type LoadingFilterField = keyof typeof loadingFilterFields;
export type LoadingFilterOperator =
  | "equals"
  | "contains"
  | "exists"
  | "not_equals"
  | "not_contains"
  | "not_exists"
  | "starts_with"
  | "ends_with";

export type LoadingFilterCondition = {
  field: LoadingFilterField;
  operator: LoadingFilterOperator;
  value: string;
};

export function buildLoadingFilter(condition: LoadingFilterCondition) {
  const column = loadingFilterFields[condition.field];
  if (!column) return null;
  const normalized = condition.value.trim().toLowerCase();
  if (condition.operator === "exists")
    return { clause: `COALESCE(TRIM(${column}),'')<>''`, bindings: [] as string[] };
  if (condition.operator === "not_exists")
    return { clause: `COALESCE(TRIM(${column}),'')=''`, bindings: [] as string[] };
  if (!normalized) return null;
  if (condition.operator === "equals")
    return { clause: `LOWER(COALESCE(${column},''))=?`, bindings: [normalized] };
  if (condition.operator === "not_equals")
    return { clause: `LOWER(COALESCE(${column},''))<>?`, bindings: [normalized] };
  const escaped = normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const pattern =
    condition.operator === "starts_with"
      ? `${escaped}%`
      : condition.operator === "ends_with"
        ? `%${escaped}`
        : `%${escaped}%`;
  return {
    clause: `LOWER(COALESCE(${column},'')) ${condition.operator === "not_contains" ? "NOT LIKE" : "LIKE"} ? ESCAPE '\\'`,
    bindings: [pattern],
  };
}

export type RouteIdentity = {
  origin_country: string;
  origin_state?: string | null;
  origin_city: string;
  destination_country: string;
  destination_state?: string | null;
  destination_city: string;
};

export function loadingRouteKey(order: RouteIdentity) {
  const part = (value: string | null | undefined) =>
    (value ?? "").trim().toLocaleLowerCase();
  return `${part(order.origin_country)}|${part(order.origin_state)}|${part(order.origin_city)}>${part(order.destination_country)}|${part(order.destination_state)}|${part(order.destination_city)}`;
}

export type LoadingMeasure = {
  id?: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
};

export function summarizeLoadingSelection(
  currentOrder: LoadingMeasure,
  candidates: LoadingMeasure[],
  selectedIds: string[],
) {
  const selected = candidates.filter(
    (item) => item.id && selectedIds.includes(item.id),
  );
  return [currentOrder, ...selected].reduce(
    (sum, item) => ({
      orderCount: sum.orderCount + 1,
      pieces: sum.pieces + item.pieces,
      weight: sum.weight + item.gross_weight_kg,
      volume: sum.volume + item.volume_cbm,
    }),
    { orderCount: 0, pieces: 0, weight: 0, volume: 0 },
  );
}
