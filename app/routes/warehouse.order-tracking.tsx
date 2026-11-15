import { env } from "cloudflare:workers";
import type { Route } from "./+types/warehouse.order-tracking";
import { requireSessionUser } from "../lib/auth.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { loadOrderTrackingReadView } from "../lib/order-tracking-read.server";
import { ReadOnlyOrderTracking } from "../components/ReadOnlyOrderTracking";
export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "warehouse.view", "warehouse");
  const { selected } = await loadWarehouseContext(request, current);
  return loadOrderTrackingReadView(env.DB, current, new URL(request.url).searchParams, selected);
}
export default function WarehouseTracking({ loaderData }: Route.ComponentProps) {
  return <ReadOnlyOrderTracking data={loaderData} site="warehouse"/>;
}
