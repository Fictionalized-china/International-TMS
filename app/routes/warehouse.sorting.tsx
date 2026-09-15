import { redirect } from "react-router";
import type { Route } from "./+types/warehouse.sorting";
import { requireSessionUser } from "../lib/auth.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";

function acceptanceUrl(request: Request, warehouseId: string) {
  const source = new URL(request.url);
  const params = new URLSearchParams({ warehouseId });
  const returnTo = source.searchParams.get("returnTo");
  if (returnTo) params.set("returnTo", returnTo);
  return `/warehouse/acceptance?${params.toString()}`;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouse = (await loadWarehouseContext(request, user)).selected;
  throw redirect(acceptanceUrl(request, warehouse.id));
}

export default function LegacySortingRedirect() {
  return null;
}

export function meta() {
  return [{ title: "验收收货 | International TMS" }];
}
