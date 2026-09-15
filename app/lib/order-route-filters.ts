export type OrderRouteFilters = {
  origin: string;
  exitPort: string;
  destination: string;
};

type RouteFilterSource = Pick<
  URLSearchParams,
  "get"
>;

export function readOrderRouteFilters(searchParams: RouteFilterSource): OrderRouteFilters {
  return {
    origin: (searchParams.get("origin") || "").trim(),
    exitPort: (searchParams.get("exitPort") || "").trim(),
    destination: (searchParams.get("destination") || "").trim(),
  };
}

export function orderRouteFilterCount(filters: OrderRouteFilters) {
  return [filters.origin, filters.exitPort, filters.destination].filter(Boolean).length;
}

export function matchesOrderRouteFilters(
  order: {
    origin_country?: string | null;
    origin_state?: string | null;
    origin_city?: string | null;
    origin_address?: string | null;
    exit_port?: string | null;
    exit_port_name?: string | null;
    destination_country?: string | null;
    destination_state?: string | null;
    destination_city?: string | null;
    destination_address?: string | null;
    overseas_warehouse_name?: string | null;
  },
  filters: OrderRouteFilters,
) {
  const includes = (values: Array<string | null | undefined>, query: string) =>
    !query || values.filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN"));

  return includes(
    [order.origin_country, order.origin_state, order.origin_city, order.origin_address],
    filters.origin,
  ) && includes(
    [order.exit_port, order.exit_port_name],
    filters.exitPort,
  ) && includes(
    [order.destination_country, order.destination_state, order.destination_city, order.destination_address, order.overseas_warehouse_name],
    filters.destination,
  );
}
