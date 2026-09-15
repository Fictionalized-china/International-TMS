import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.login";
import { clearLoginFailures, createSession, isLoginLocked, recordLoginFailure } from "../lib/auth.server";
import { verifyPassword } from "../lib/crypto.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { siteFromRequest, siteLogin } from "../lib/site.server";
import { createSessionSlot, sessionSlotFromUrl, withSessionSlot } from "../lib/session-slot";
import { loadActivePositionAccessProfile } from "../lib/position-access-profile.server";

export function meta(){return[{title:"仓库作业登录 | International TMS"}]}

export async function loader({request}:Route.LoaderArgs){
  const site=siteFromRequest(request);if(site!=="warehouse")throw redirect(siteLogin(site));
  const sessionSlot=sessionSlotFromUrl(request.url);
  if(!sessionSlot)throw redirect(withSessionSlot("/warehouse/login",createSessionSlot()));
  return { sessionSlot };
}

export async function action({request}:Route.ActionArgs){
  const site=siteFromRequest(request);if(site!=="warehouse")throw redirect(siteLogin(site));
  const form=await request.formData(),email=valueOf(form,"email").toLowerCase(),password=valueOf(form,"password");
  const user=await env.DB.prepare(`SELECT u.id,u.password_hash,u.failed_login_count,u.locked_until,m.organization_id
    FROM users u JOIN memberships m ON m.user_id=u.id AND m.status='active'
    WHERE u.email=? AND u.status='active' LIMIT 1`)
    .bind(email).first<{id:string;password_hash:string;failed_login_count:number;locked_until:string|null;organization_id:string;can_manage_warehouse?:number}>();
  if(user&&isLoginLocked(user.locked_until))return{error:"登录尝试过多，请 15 分钟后再试",email};
  const accessProfile=user
    ? await loadActivePositionAccessProfile(env.DB,user.organization_id,user.id)
    : null;
  if(!user||!accessProfile||!accessProfile.permissions.includes("warehouse.view")||!(await verifyPassword(password,user.password_hash))){
    if(user)await recordLoginFailure(user.id,user.failed_login_count);
    await writeAudit({request,action:"warehouse.login",resourceType:"session",outcome:"failure",metadata:{email}});
    return{error:"邮箱或密码不正确，或未开通仓库权限",email};
  }
  await clearLoginFailures(user.id);
  const canManageWarehouse=accessProfile.permissions.includes("warehouse.manage");
  user.can_manage_warehouse=canManageWarehouse?1:0;
  const warehouseResult=await env.DB.prepare(`SELECT w.id,w.code,w.name
    FROM warehouses w
    WHERE w.organization_id=? AND w.status='active'
      AND (?=1 OR EXISTS(SELECT 1 FROM warehouse_user_access a WHERE a.organization_id=w.organization_id AND a.warehouse_id=w.id AND a.user_id=?))
    ORDER BY CASE w.warehouse_role WHEN 'domestic_collection' THEN 1 WHEN 'port' THEN 2 ELSE 3 END,w.code
    LIMIT 2`)
    .bind(user.organization_id,canManageWarehouse?1:0,user.id)
    .all<{id:string;code:string;name:string}>();
  if(!warehouseResult.results.length)return{error:"当前账号没有可进入的启用仓库，请联系管理员检查仓库绑定",email};
  if(!user.can_manage_warehouse&&warehouseResult.results.length!==1)return{error:"当前账号绑定了多个仓库，请联系管理员按“一仓一号”修正后再登录",email};
  const warehouse=warehouseResult.results[0];
  await writeAudit({request,action:"warehouse.login",resourceType:"session",organizationId:user.organization_id,actorUserId:user.id});
  const sessionSlot=sessionSlotFromUrl(request.url)||createSessionSlot();
  return redirect(withSessionSlot(`/warehouse?warehouseId=${encodeURIComponent(warehouse.id)}`,sessionSlot),{headers:{"Set-Cookie":await createSession(user.id,user.organization_id,"warehouse",warehouse.id,sessionSlot)}});
}

export default function WarehouseLogin({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle";
  return <main className="auth-page warehouse-auth"><section className="auth-card"><div className="brand-mark warehouse-mark">WH</div><p className="eyebrow">OULING WAREHOUSE</p><h1>仓库作业</h1><p className="muted">现场人员独立登录入口</p>{actionData?.error&&<div className="alert error">{actionData.error}</div>}
    <Form method="post" action={withSessionSlot("/warehouse/login",loaderData.sessionSlot)} className="stack"><label className="field"><span>员工邮箱</span><input name="email" type="email" defaultValue={actionData?.email||""} required autoComplete="email" autoFocus/></label><label className="field"><span>密码</span><input name="password" type="password" required autoComplete="current-password"/></label><button className="primary warehouse-primary" disabled={busy}>{busy?"正在登录…":"进入仓库作业"}</button></Form><a className="site-switch" href="/login">运营后台登录 →</a></section></main>;
}
