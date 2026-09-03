import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/switch-site";
import { createSession, getSessionUser, warehouseIdFromRequest } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { sessionSlotFromRequest, withSessionSlot } from "../lib/session-slot";

export async function loader({request}:Route.LoaderArgs){throw redirect(withSessionSlot("/login",sessionSlotFromRequest(request)))}

export async function action({request}:Route.ActionArgs){
  const form=await request.formData(),target=valueOf(form,"target");
  const sessionSlot=sessionSlotFromRequest(request);
  if(!["admin","warehouse"].includes(target))return new Response("不支持的站点",{status:400});
  const sourceSite=target==="warehouse"?"admin":"warehouse";
  const current=await getSessionUser(request,sourceSite,sourceSite==="warehouse"?warehouseIdFromRequest(request):null);
  if(!current)throw redirect(sourceSite==="warehouse"?"/warehouse/login":"/login");
  const membership=await env.DB.prepare("SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND status='active'").bind(current.organizationId,current.userId).first();
  if(!membership)return new Response("当前账号没有管理后台访问权限",{status:403});
  if(target==="warehouse"){
    const permission=await env.DB.prepare(`SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.membership_id=m.id JOIN role_permissions rp ON rp.role_id=mr.role_id WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND rp.permission_code='warehouse.view' LIMIT 1`).bind(current.organizationId,current.userId).first();
    if(!permission)return new Response("当前账号没有仓库作业访问权限",{status:403});
    const requestedWarehouseTo=valueOf(form,"warehouseTo");
    const safeWarehouseTo=(requestedWarehouseTo==="/warehouse"||requestedWarehouseTo.startsWith("/warehouse/")||requestedWarehouseTo.startsWith("/warehouse?"))&&!requestedWarehouseTo.startsWith("//")?requestedWarehouseTo:"/warehouse";
    const warehouseUrl=new URL(safeWarehouseTo,"http://local");
    const requestedWarehouseId=warehouseUrl.searchParams.get("warehouseId");
    const warehouse=await env.DB.prepare(`SELECT w.id
      FROM warehouses w
      WHERE w.organization_id=? AND w.status='active'
        AND (? IS NULL OR w.id=?)
        AND (
          EXISTS(SELECT 1 FROM warehouse_user_access a WHERE a.organization_id=w.organization_id AND a.warehouse_id=w.id AND a.user_id=?)
          OR EXISTS(
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id=m.id
            JOIN role_permissions rp ON rp.role_id=mr.role_id AND rp.permission_code='warehouse.manage'
            WHERE m.organization_id=w.organization_id AND m.user_id=? AND m.status='active'
          )
        )
      ORDER BY CASE w.warehouse_role WHEN 'domestic_collection' THEN 1 WHEN 'port' THEN 2 ELSE 3 END,w.code
      LIMIT 1`)
      .bind(current.organizationId,requestedWarehouseId,requestedWarehouseId,current.userId,current.userId)
      .first<{id:string}>();
    if(!warehouse)return new Response("当前账号没有可进入的启用仓库",{status:403});
    warehouseUrl.searchParams.set("warehouseId",warehouse.id);
    const warehouseTo=`${warehouseUrl.pathname}?${warehouseUrl.searchParams.toString()}`;
    await writeAudit({request,action:"auth.site.switch",resourceType:"session",organizationId:current.organizationId,actorUserId:current.userId,metadata:{from:current.site,to:"warehouse"}});
    return redirect(withSessionSlot(warehouseTo,sessionSlot),{headers:{"Set-Cookie":await createSession(current.userId,current.organizationId,"warehouse",warehouse.id,sessionSlot)}});
  }
  await writeAudit({request,action:"auth.site.switch",resourceType:"session",organizationId:current.organizationId,actorUserId:current.userId,metadata:{from:current.site,to:"admin"}});
  const requestedReturn=valueOf(form,"returnTo");
  const returnTo=(requestedReturn==="/admin"||requestedReturn.startsWith("/admin/")||requestedReturn.startsWith("/admin?"))&&!requestedReturn.startsWith("//")?requestedReturn:"/admin";
  return redirect(withSessionSlot(returnTo,sessionSlot),{headers:{"Set-Cookie":await createSession(current.userId,current.organizationId,"admin",null,sessionSlot)}});
}
