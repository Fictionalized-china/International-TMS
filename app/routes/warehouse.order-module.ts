import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/warehouse.order-module";
import { requireSessionUser } from "../lib/auth.server";
import { advanceOrderModule } from "../lib/order-modules.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { activePositionProfilePredicate, loadActivePositionAccessProfile } from "../lib/position-access-profile.server";
import { warehousePhysicalWorkflowAccessSql } from "../lib/warehouse-workflow-access.server";
import { predicateGuard } from "../lib/mutation-guard.server";
import { isBossBusinessActor } from "../lib/permission-blocks";

const plannedDomesticWarehouseSql = `EXISTS(
  SELECT 1 FROM order_transport_assignments a
  WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.destination_warehouse_id=?
    AND a.id=(SELECT ax.id FROM order_transport_assignments ax
      WHERE ax.organization_id=o.organization_id AND ax.order_id=o.id AND ax.leg_type='first_mile' AND ax.status!='cancelled'
      ORDER BY ax.updated_at DESC,ax.created_at DESC LIMIT 1)
)`;

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
  const profile = await loadActivePositionAccessProfile(env.DB,current.organizationId,current.userId);
  if (!profile?.permissions.includes("warehouse.operate")) throw new Response("账号或仓库操作权限已停用",{status:403});
  const actor = {...current,...profile,roleCodes:[profile.roleCode]};
  const {selected:warehouse} = await loadWarehouseContext(request,actor);
  await requireWarehouseAssignment(actor,warehouse.id,"operator");
  const form = await request.formData();
  const orderId = valueOf(form, "orderId");
  const redirectTo = safeWarehouseReturn(valueOf(form, "redirectTo"));
  if (warehouse.warehouse_role === "overseas_destination")
    throw redirect(resultRedirect(redirectTo,"warehouseError","境外目的仓请使用扫码入库，不在国内仓模块推进"));
  const workflow = warehousePhysicalWorkflowAccessSql("o","warehouse",actor);
  const allowedOrderSql = `EXISTS(SELECT 1 FROM transport_orders o WHERE o.id=? AND o.organization_id=?
    AND o.status IN ('confirmed','in_execution') AND ${plannedDomesticWarehouseSql} AND ${workflow.sql})`;
  const orderValues = [orderId,current.organizationId,warehouse.id,...workflow.values];
  const order = await env.DB.prepare(
    `SELECT 1 valid WHERE ${allowedOrderSql}`,
  )
    .bind(...orderValues)
    .first<{ valid: number }>();
  if (!order)
    throw redirect(resultRedirect(redirectTo, "warehouseError", "订单不可办理：请核对计划收货仓、当前仓库及冻结流程节点"));
  const now = new Date().toISOString();
  const manager = profile.permissions.includes("warehouse.manage");
  const authority = activePositionProfilePredicate({organizationId:current.organizationId,userId:current.userId,profile,requiredPermissions:["warehouse.operate",...(manager?["warehouse.manage"]:[])]});
  const boss = isBossBusinessActor(actor);
  const warehouseScopeSql = boss ? "1=1" : `(
    (EXISTS(SELECT 1 FROM warehouse_user_access a WHERE a.organization_id=? AND a.user_id=? AND a.warehouse_id=? AND (?=1 OR a.access_level IN ('operator','manager')))
      AND (SELECT COUNT(*) FROM warehouse_user_access a WHERE a.organization_id=? AND a.user_id=?)=1)
    OR (?=1 AND NOT EXISTS(SELECT 1 FROM warehouse_user_access a WHERE a.organization_id=? AND a.user_id=?))
  )`;
  const warehouseScopeValues = boss ? [] : [current.organizationId,current.userId,warehouse.id,manager?1:0,current.organizationId,current.userId,manager?1:0,current.organizationId,current.userId];
  try {
    await advanceOrderModule({
      organizationId: current.organizationId,
      orderId,
      moduleCode: "warehouse",
      actorUserId: current.userId,
      notes: "仓库作业端确认当前节点完成",
      commitGuards: [
        predicateGuard(env.DB,authority.sql,authority.values,now),
        predicateGuard(env.DB,warehouseScopeSql,warehouseScopeValues,now),
        predicateGuard(env.DB,"EXISTS(SELECT 1 FROM warehouses WHERE id=? AND organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port'))",[warehouse.id,current.organizationId],now),
        predicateGuard(env.DB,allowedOrderSql,orderValues,now),
      ],
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
