import type { Route } from "./+types/admin.order-mark-label";
import { OrderMarkLabelPage } from "../components/OrderMarkLabelPage";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderMarkLabel, orderMarkLabelDownload } from "../lib/order-mark-label.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const order = await loadOrderMarkLabel({ organizationId: current.organizationId, orderId: params.orderId });
  if (new URL(request.url).searchParams.get("download") === "1") return orderMarkLabelDownload(order);
  return { order };
}

export default function AdminOrderMarkLabel({ loaderData }: Route.ComponentProps) {
  return <OrderMarkLabelPage order={loaderData.order} returnTo={`/admin/orders/${loaderData.order.id}`} />;
}

export function meta() {
  return [{ title: "入仓唛头标签 | International TMS" }];
}
