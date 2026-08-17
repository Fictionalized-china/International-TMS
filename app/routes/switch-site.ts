import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/switch-site";
import { createSession, getSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";

export async function loader(){throw redirect("/login")}

export async function action({request}:Route.ActionArgs){
  const current=await getSessionUser(request);
  if(!current)throw redirect("/login");
  const form=await request.formData(),target=valueOf(form,"target");
  if(!["admin","warehouse"].includes(target))return new Response("不支持的站点",{status:400});
  const membership=await env.DB.prepare("SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND status='active'").bind(current.organizationId,current.userId).first();
  if(!membership)return new Response("当前账号没有管理后台访问权限",{status:403});
  if(target==="warehouse"){
    const permission=await env.DB.prepare(`SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.membership_id=m.id JOIN role_permissions rp ON rp.role_id=mr.role_id WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND rp.permission_code='warehouse.view' LIMIT 1`).bind(current.organizationId,current.userId).first();
    if(!permission)return new Response("当前账号没有仓库作业访问权限",{status:403});
    const requestedWarehouseTo=valueOf(form,"warehouseTo");
    const warehouseTo=(requestedWarehouseTo==="/warehouse"||requestedWarehouseTo.startsWith("/warehouse/")||requestedWarehouseTo.startsWith("/warehouse?"))&&!requestedWarehouseTo.startsWith("//")?requestedWarehouseTo:"/warehouse";
    await writeAudit({request,action:"auth.site.switch",resourceType:"session",organizationId:current.organizationId,actorUserId:current.userId,metadata:{from:current.site,to:"warehouse"}});
    return redirect(warehouseTo,{headers:{"Set-Cookie":await createSession(current.userId,current.organizationId,"warehouse")}});
  }
  await writeAudit({request,action:"auth.site.switch",resourceType:"session",organizationId:current.organizationId,actorUserId:current.userId,metadata:{from:current.site,to:"admin"}});
  const requestedReturn=valueOf(form,"returnTo");
  const returnTo=(requestedReturn==="/admin"||requestedReturn.startsWith("/admin/")||requestedReturn.startsWith("/admin?"))&&!requestedReturn.startsWith("//")?requestedReturn:"/admin";
  return redirect(returnTo,{headers:{"Set-Cookie":await createSession(current.userId,current.organizationId,"admin")}});
}
