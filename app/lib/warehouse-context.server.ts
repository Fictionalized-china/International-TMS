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

  const sql = access.all
    ? `SELECT id,code,name,warehouse_role,country_code,city
       FROM warehouses
       WHERE organization_id=? AND status='active'
       ORDER BY CASE warehouse_role WHEN 'domestic_collection' THEN 10 WHEN 'port' THEN 20 ELSE 30 END,code`
    : `SELECT id,code,name,warehouse_role,country_code,city
       FROM warehouses
       WHERE organization_id=? AND status='active'
         AND id IN (${access.warehouseIds.map(() => "?").join(",")})
       ORDER BY CASE warehouse_role WHEN 'domestic_collection' THEN 10 WHEN 'port' THEN 20 ELSE 30 END,code`;
  const result = await env.DB.prepare(sql)
    .bind(user.organizationId, ...(access.all ? [] : access.warehouseIds))
    .all<WarehouseContextOption>();
  if (!result.results.length)
    throw new Response("当前没有可访问的启用仓库", { status: 403 });

  // Warehouse pages are account-scoped. Query parameters must not allow an
  // operator to switch the active warehouse implicitly.
  const selected = result.results[0];
  return { warehouses: result.results, selected };
}
