import type { OrderRouteFilters } from "../lib/order-route-filters";

export function OrderRouteFilterFields({ filters }: { filters: OrderRouteFilters }) {
  return <>
    <label className="field">
      <span>出发地</span>
      <input name="origin" defaultValue={filters.origin} placeholder="国家、省州、城市或地址" />
    </label>
    <label className="field">
      <span>出境口岸</span>
      <input name="exitPort" defaultValue={filters.exitPort} placeholder="口岸名称或代码" />
    </label>
    <label className="field">
      <span>目的地</span>
      <input name="destination" defaultValue={filters.destination} placeholder="国家、城市、地址或目的仓" />
    </label>
  </>;
}
