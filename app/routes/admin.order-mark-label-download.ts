import type { Route } from "./+types/admin.order-mark-label-download";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderMarkLabel, orderMarkLabelDownload } from "../lib/order-mark-label.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const order = await loadOrderMarkLabel({
    organizationId: current.organizationId,
    orderId: params.orderId,
  });
  return orderMarkLabelDownload(order);
}
