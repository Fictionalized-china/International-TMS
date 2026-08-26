import type { Route } from "./+types/portal.order-mark-label";
import { OrderMarkLabelPage } from "../components/OrderMarkLabelPage";
import { loadOrderMarkLabel, orderMarkLabelDownload } from "../lib/order-mark-label.server";
import { requirePortalCustomer } from "../lib/portal.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const order = await loadOrderMarkLabel({
    organizationId: user.organizationId,
    customerId: customer.id,
    orderId: params.orderId,
  });
  if (new URL(request.url).searchParams.get("download") === "1") return orderMarkLabelDownload(order);
  return { order };
}

export default function PortalOrderMarkLabel({ loaderData }: Route.ComponentProps) {
  return <OrderMarkLabelPage order={loaderData.order} returnTo="/portal/orders" />;
}

export function meta() {
  return [{ title: "入仓唛头标签 | 客户门户" }];
}
