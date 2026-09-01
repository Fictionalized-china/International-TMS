import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/portal.login";
import { clearLoginFailures, createSession, getSessionUser, isLoginLocked, recordLoginFailure } from "../lib/auth.server";
import { verifyPassword } from "../lib/crypto.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import {
  PORTAL_CONTEXT_PARAM,
  normalizePortalContextId,
  portalContextIdFromRequest,
  portalContextualPath,
} from "../lib/portal-session-context";
import { siteFromRequest, siteLogin } from "../lib/site.server";

export function meta() { return [{ title: "客户门户登录 | International TMS" }]; }

export async function loader({ request }: Route.LoaderArgs) {
  const site=siteFromRequest(request); if(site!=="portal")throw redirect(siteLogin(site));
  const contextId = portalContextIdFromRequest(request) || crypto.randomUUID();
  if ((await getSessionUser(request, "portal", null, contextId))?.site === "portal") {
    throw redirect(portalContextualPath("/portal", contextId));
  }
  return { contextId };
}

export async function action({ request }: Route.ActionArgs) {
  const site=siteFromRequest(request); if(site!=="portal")throw redirect(siteLogin(site));
  const form = await request.formData();
  const email = valueOf(form, "email").toLowerCase();
  const password = valueOf(form, "password");
  const contextId = normalizePortalContextId(valueOf(form, PORTAL_CONTEXT_PARAM)) || crypto.randomUUID();
  const user = await env.DB.prepare(
    `SELECT u.id, u.password_hash, u.failed_login_count, u.locked_until, cpa.organization_id
       FROM users u
       JOIN customer_portal_accounts cpa ON cpa.user_id = u.id AND cpa.status = 'active'
      WHERE u.email = ? AND u.status = 'active' LIMIT 1`,
  ).bind(email).first<{ id: string; password_hash: string; failed_login_count: number; locked_until: string | null; organization_id: string }>();
  if (user && isLoginLocked(user.locked_until)) return { error: "登录尝试过多，请 15 分钟后再试", email, contextId };
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    if (user) await recordLoginFailure(user.id, user.failed_login_count);
    await writeAudit({ request, action: "portal.login", resourceType: "session", outcome: "failure", metadata: { email } });
    return { error: "邮箱或密码不正确，或尚未开通客户门户", email, contextId };
  }
  await clearLoginFailures(user.id);
  await writeAudit({ request, action: "portal.login", resourceType: "session", organizationId: user.organization_id, actorUserId: user.id });
  return redirect(portalContextualPath("/portal", contextId), {
    headers: { "Set-Cookie": await createSession(user.id, user.organization_id, "portal", null, contextId) },
  });
}

export default function PortalLogin({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const contextId = actionData?.contextId || loaderData.contextId;
  return <main className="auth-page portal-auth"><section className="auth-card">
    <div className="brand-mark portal-mark">OT</div><p className="eyebrow">OULING CUSTOMER PORTAL</p><h1>客户门户</h1><p className="muted">查询业务资料并与欧凌国际物流协作</p>
    {actionData?.error && <div className="alert error">{actionData.error}</div>}
    <Form method="post" className="stack"><input type="hidden" name={PORTAL_CONTEXT_PARAM} value={contextId} /><label className="field"><span>邮箱</span><input name="email" type="email" defaultValue={actionData?.email} required autoComplete="email" /></label><label className="field"><span>密码</span><input name="password" type="password" required autoComplete="current-password" /></label><button className="primary portal-primary" disabled={busy}>{busy ? "正在登录…" : "进入客户门户"}</button></Form>
    <a className="site-switch" href="/login">内部员工登录 →</a>
  </section></main>;
}
