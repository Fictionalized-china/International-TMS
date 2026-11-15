import { env } from "cloudflare:workers";
import type { Route } from "./+types/admin.order-tracking";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderTrackingReadView } from "../lib/order-tracking-read.server";
import { ReadOnlyOrderTracking } from "../components/ReadOnlyOrderTracking";
import { AdminWorkspaceTabs } from "../components/AdminWorkspaceTabs";
export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  return { current, ...await loadOrderTrackingReadView(env.DB, current, new URL(request.url).searchParams) };
}
export default function OrderTracking({ loaderData }: Route.ComponentProps) {
  return <><AdminWorkspaceTabs user={loaderData.current} workspace="orders"/><ReadOnlyOrderTracking data={loaderData} site="admin"/></>;
}
