import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.login";
import { clearLoginFailures, createSession, getSessionUser, isLoginLocked, recordLoginFailure } from "../lib/auth.server";
import { verifyPassword } from "../lib/crypto.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { siteFromRequest, siteLogin } from "../lib/site.server";

export function meta(){return[{title:"仓库作业登录 | International TMS"}]}

export async function loader({request}:Route.LoaderArgs){
  const site=siteFromRequest(request);if(site!=="warehouse")throw redirect(siteLogin(site));
  if((await getSessionUser(request))?.site==="warehouse")throw redirect("/warehouse");
  return null;
}

export async function action({request}:Route.ActionArgs){
  const site=siteFromRequest(request);if(site!=="warehouse")throw redirect(siteLogin(site));
  const form=await request.formData(),email=valueOf(form,"email").toLowerCase(),password=valueOf(form,"password");
  const user=await env.DB.prepare(`SELECT u.id,u.password_hash,u.failed_login_count,u.locked_until,m.organization_id
    FROM users u JOIN memberships m ON m.user_id=u.id AND m.status='active'
    WHERE u.email=? AND u.status='active' AND EXISTS(
      SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id=mr.role_id
      WHERE mr.membership_id=m.id AND rp.permission_code='warehouse.view') LIMIT 1`)
    .bind(email).first<{id:string;password_hash:string;failed_login_count:number;locked_until:string|null;organization_id:string}>();
  if(user&&isLoginLocked(user.locked_until))return{error:"登录尝试过多，请 15 分钟后再试",email};
  if(!user||!(await verifyPassword(password,user.password_hash))){
    if(user)await recordLoginFailure(user.id,user.failed_login_count);
    await writeAudit({request,action:"warehouse.login",resourceType:"session",outcome:"failure",metadata:{email}});
    return{error:"邮箱或密码不正确，或未开通仓库权限",email};
  }
  await clearLoginFailures(user.id);
  await writeAudit({request,action:"warehouse.login",resourceType:"session",organizationId:user.organization_id,actorUserId:user.id});
  return redirect("/warehouse",{headers:{"Set-Cookie":await createSession(user.id,user.organization_id,"warehouse")}});
}

export default function WarehouseLogin({actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle";
  return <main className="auth-page warehouse-auth"><section className="auth-card"><div className="brand-mark warehouse-mark">WH</div><p className="eyebrow">OULING WAREHOUSE</p><h1>仓库作业</h1><p className="muted">现场人员独立登录入口</p>{actionData?.error&&<div className="alert error">{actionData.error}</div>}<Form method="post" className="stack"><label className="field"><span>员工邮箱</span><input name="email" type="email" defaultValue={actionData?.email} required autoComplete="email"/></label><label className="field"><span>密码</span><input name="password" type="password" required autoComplete="current-password"/></label><button className="primary warehouse-primary" disabled={busy}>{busy?"正在登录…":"进入仓库作业"}</button></Form><a className="site-switch" href="/login">运营后台登录 →</a></section></main>;
}
