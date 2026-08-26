import { redirect } from "react-router";
import type { Route } from "./+types/warehouse.ltl-loading";
import { requireSessionUser } from "../lib/auth.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";

function pendingWorkbenchUrl(request: Request, warehouseId: string) {
  const url = new URL(request.url);
  const params = new URLSearchParams({ warehouseId, view: "pending" });
  const orderId = url.searchParams.get("orderId");
  const returnTo = url.searchParams.get("returnTo");
  if (orderId) params.set("orderId", orderId);
  if (returnTo) params.set("returnTo", returnTo);
  return `/warehouse/outbound?${params.toString()}`;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouse = (await loadWarehouseContext(request, user)).selected;
  throw redirect(pendingWorkbenchUrl(request, warehouse.id));
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const warehouse = (await loadWarehouseContext(request, user)).selected;
  await requireWarehouseAssignment(user, warehouse.id, "operator");
  throw redirect(pendingWorkbenchUrl(request, warehouse.id));
}

export default function LegacyLtlLoadingRedirect() {
  return null;
}

export function meta() {
  return [{ title: "待装车 | International TMS" }];
}
