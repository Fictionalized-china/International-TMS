import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/warehouse.order-module";
import { requireSessionUser } from "../lib/auth.server";
import { advanceOrderModule } from "../lib/order-modules.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";

export async function loader() {
  throw redirect("/warehouse");
}

function safeWarehouseReturn(value: string) {
  return (value === "/warehouse" ||
    value.startsWith("/warehouse/") ||
    value.startsWith("/warehouse?")) &&
    !value.startsWith("//")
    ? value
    : "/warehouse";
}

function resultRedirect(path: string, key: string, message: string) {
  const url = new URL(path, "http://local");
  url.searchParams.delete("warehouseResult");
  url.searchParams.delete("warehouseError");
  url.searchParams.set(key, message);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const form = await request.formData();
  const orderId = valueOf(form, "orderId");
  const redirectTo = safeWarehouseReturn(valueOf(form, "redirectTo"));
  const order = await env.DB.prepare(
    "SELECT status FROM transport_orders WHERE id=? AND organization_id=?",
  )
    .bind(orderId, current.organizationId)
    .first<{ status: string }>();
  if (!order)
    throw redirect(resultRedirect(redirectTo, "warehouseError", "订单不存在或无权访问"));
  if (!["confirmed", "in_execution"].includes(order.status))
    throw redirect(
      resultRedirect(redirectTo, "warehouseError", "订单尚未审核或已结束，当前不可推进仓库流程"),
    );
  try {
    await advanceOrderModule({
      organizationId: current.organizationId,
      orderId,
      moduleCode: "warehouse",
      actorUserId: current.userId,
      notes: "仓库作业端确认当前节点完成",
    });
    await writeAudit({
      request,
      action: "warehouse.order.module.advance",
      resourceType: "transport_order",
      resourceId: orderId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { source: "warehouse_site" },
    });
    throw redirect(resultRedirect(redirectTo, "warehouseResult", "仓库节点已推进，并同步到订单中心"));
  } catch (error) {
    if (error instanceof Response) throw error;
    const message = error instanceof Error ? error.message : "仓库流程推进失败";
    throw redirect(resultRedirect(redirectTo, "warehouseError", message));
  }
}
