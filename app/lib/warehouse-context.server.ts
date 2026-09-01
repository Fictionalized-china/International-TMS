import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { getWarehouseAccess } from "./warehouse-access.server";
import type { WarehouseRole } from "./road-master-data";

export type WarehouseContextOption = {
  id: string;
  code: string;
  name: string;
  warehouse_role: WarehouseRole;
  country_code: string | null;
  city: string | null;
};

export async function loadWarehouseContext(request: Request, user: SessionUser) {
  const access = await getWarehouseAccess(user);
  if (!access.all && !access.warehouseIds.length)
    throw new Response("尚未分配可访问仓库，请联系管理员", { status: 403 });

  const result = access.all
    ? await env.DB.prepare(
      `SELECT w.id,w.code,w.name,w.warehouse_role,w.country_code,w.city
       FROM warehouses w
       WHERE w.organization_id=? AND w.status='active'
       ORDER BY CASE w.warehouse_role WHEN 'domestic_collection' THEN 10 WHEN 'port' THEN 20 ELSE 30 END,w.code`,
    ).bind(user.organizationId).all<WarehouseContextOption>()
    : await env.DB.prepare(
      `SELECT w.id,w.code,w.name,w.warehouse_role,w.country_code,w.city
       FROM warehouses w
       JOIN warehouse_user_access access
         ON access.organization_id=w.organization_id AND access.warehouse_id=w.id
       WHERE w.organization_id=? AND w.status='active' AND access.user_id=?
       ORDER BY CASE w.warehouse_role WHEN 'domestic_collection' THEN 10 WHEN 'port' THEN 20 ELSE 30 END,w.code`,
    ).bind(user.organizationId, user.userId).all<WarehouseContextOption>();
  if (!result.results.length)
    throw new Response("当前没有可访问的启用仓库", { status: 403 });

  const requestedWarehouseId = new URL(request.url).searchParams.get("warehouseId");
  const selected = requestedWarehouseId
    ? result.results.find((warehouse) => warehouse.id === requestedWarehouseId)
    : result.results[0];
  if (!selected)
    throw new Response("当前登录账号无权访问所选仓库，请使用该仓库绑定账号重新登录", { status: 403 });
  return { warehouses: result.results, selected };
}
