import type { Route } from "./+types/portal.order-mark-label-download";
import { loadOrderMarkLabel, orderMarkLabelDownload } from "../lib/order-mark-label.server";
import { requirePortalCustomer } from "../lib/portal.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const order = await loadOrderMarkLabel({
    organizationId: user.organizationId,
    customerId: customer.id,
    orderId: params.orderId,
  });
  return orderMarkLabelDownload(order);
}
