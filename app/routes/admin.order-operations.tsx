import { redirect } from "react-router";
import type { Route } from "./+types/admin.order-operations";
import { requireSessionUser } from "../lib/auth.server";
import { requireOrderAccess } from "../lib/order-access.server";

/** Compatibility URL only: all reads and mutations use the current module authorization. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  await requireOrderAccess(current, params.orderId);
  return redirect(`/admin/orders/${encodeURIComponent(params.orderId!)}`);
}
export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.manage");
  await requireOrderAccess(current, params.orderId);
  throw new Response("旧订单操作页已进入只读兼容模式，请返回订单详情并进入对应业务模块办理。", {
    status: 405, headers: { Allow: "GET" },
  });
}
export default function LegacyOrderOperations() { return null; }
