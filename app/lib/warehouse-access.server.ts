import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { resolveWarehouseAccess } from "./warehouse-access";

const rank:Record<string,number>={viewer:1,operator:2,manager:3};

export async function getWarehouseAccess(user:SessionUser){
  const rows=await env.DB.prepare("SELECT warehouse_id,access_level FROM warehouse_user_access WHERE organization_id=? AND user_id=?").bind(user.organizationId,user.userId).all<{warehouse_id:string;access_level:string}>();
  return resolveWarehouseAccess(user, rows.results);
}

export async function requireWarehouseAssignment(user:SessionUser,warehouseId:string,required:"viewer"|"operator"|"manager"="viewer"){
  if(user.permissions.includes("warehouse.manage"))return;
  const row=await env.DB.prepare("SELECT access_level FROM warehouse_user_access WHERE organization_id=? AND user_id=? AND warehouse_id=?").bind(user.organizationId,user.userId,warehouseId).first<{access_level:string}>();
  if(!row||rank[row.access_level]<rank[required])throw new Response("没有该仓库的访问权限",{status:403});
}
