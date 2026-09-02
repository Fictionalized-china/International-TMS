import type { Route } from "./+types/admin.order-mark-label";
import { OrderMarkLabelPage } from "../components/OrderMarkLabelPage";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderMarkLabel } from "../lib/order-mark-label.server";
import { requireOrderAccess } from "../lib/order-access.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  await requireOrderAccess(current, params.orderId);
  const order = await loadOrderMarkLabel({ organizationId: current.organizationId, orderId: params.orderId });
  return { order };
}

export default function AdminOrderMarkLabel({ loaderData }: Route.ComponentProps) {
  return <OrderMarkLabelPage order={loaderData.order} returnTo={`/admin/orders/${loaderData.order.id}`} downloadTo={`/admin/orders/${loaderData.order.id}/mark-label/download`} />;
}

export function meta() {
  return [{ title: "入仓唛头标签 | International TMS" }];
}
