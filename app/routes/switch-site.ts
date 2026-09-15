import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/switch-site";
import { createSession, getSessionUser, warehouseIdFromRequest } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { sessionSlotFromRequest, withSessionSlot } from "../lib/session-slot";
import { canUseAdminSite } from "../lib/site-account-access";

export async function loader({ request }: Route.LoaderArgs) {
  throw redirect(withSessionSlot("/login", sessionSlotFromRequest(request)));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const target = valueOf(form, "target");
  const sessionSlot = sessionSlotFromRequest(request);
  if (!['admin', 'warehouse'].includes(target)) {
    return new Response("不支持的站点", { status: 400 });
  }

  const sourceSite = target === "warehouse" ? "admin" : "warehouse";
  const current = await getSessionUser(
    request,
    sourceSite,
    sourceSite === "warehouse" ? warehouseIdFromRequest(request) : null,
  );
  if (!current) throw redirect(sourceSite === "warehouse" ? "/warehouse/login" : "/login");

  if (target === "warehouse") {
    if (!current.permissions.includes("warehouse.view")) {
      return new Response("当前账号没有仓库作业访问权限", { status: 403 });
    }
    const requestedWarehouseTo = valueOf(form, "warehouseTo");
    const safeWarehouseTo = (
      requestedWarehouseTo === "/warehouse" ||
      requestedWarehouseTo.startsWith("/warehouse/") ||
      requestedWarehouseTo.startsWith("/warehouse?")
    ) && !requestedWarehouseTo.startsWith("//")
      ? requestedWarehouseTo
      : "/warehouse";
    const warehouseUrl = new URL(safeWarehouseTo, "http://local");
    const requestedWarehouseId = warehouseUrl.searchParams.get("warehouseId");
    const warehouse = await env.DB.prepare(
      `SELECT warehouse.id
       FROM warehouses warehouse
       WHERE warehouse.organization_id=? AND warehouse.status='active'
         AND (? IS NULL OR warehouse.id=?)
         AND (
           EXISTS(
             SELECT 1 FROM warehouse_user_access access
             WHERE access.organization_id=warehouse.organization_id
               AND access.warehouse_id=warehouse.id AND access.user_id=?
           )
           OR ?=1
         )
       ORDER BY CASE warehouse.warehouse_role
         WHEN 'domestic_collection' THEN 1 WHEN 'port' THEN 2 ELSE 3 END,
         warehouse.code
       LIMIT 1`,
    ).bind(
      current.organizationId,
      requestedWarehouseId,
      requestedWarehouseId,
      current.userId,
      current.permissions.includes("warehouse.manage") ? 1 : 0,
    ).first<{ id: string }>();
    if (!warehouse) {
      return new Response("当前账号没有可进入的启用仓库", { status: 403 });
    }
    warehouseUrl.searchParams.set("warehouseId", warehouse.id);
    const warehouseTo = `${warehouseUrl.pathname}?${warehouseUrl.searchParams.toString()}`;
    await writeAudit({
      request,
      action: "auth.site.switch",
      resourceType: "session",
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { from: current.site, to: "warehouse" },
    });
    return redirect(withSessionSlot(warehouseTo, sessionSlot), {
      headers: {
        "Set-Cookie": await createSession(
          current.userId,
          current.organizationId,
          "warehouse",
          warehouse.id,
          sessionSlot,
        ),
      },
    });
  }

  if (!canUseAdminSite(current.roleCodes)) {
    return new Response("当前账号没有管理后台访问权限", { status: 403 });
  }
  await writeAudit({
    request,
    action: "auth.site.switch",
    resourceType: "session",
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: { from: current.site, to: "admin" },
  });
  const requestedReturn = valueOf(form, "returnTo");
  const returnTo = (
    requestedReturn === "/admin" ||
    requestedReturn.startsWith("/admin/") ||
    requestedReturn.startsWith("/admin?")
  ) && !requestedReturn.startsWith("//")
    ? requestedReturn
    : "/admin";
  return redirect(withSessionSlot(returnTo, sessionSlot), {
    headers: {
      "Set-Cookie": await createSession(
        current.userId,
        current.organizationId,
        "admin",
        null,
        sessionSlot,
      ),
    },
  });
}
