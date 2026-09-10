import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { clearLoginFailures, createSession, getSessionUser, isLoginLocked, recordLoginFailure } from "../lib/auth.server";
import { verifyPassword } from "../lib/crypto.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { siteFromRequest, siteLogin } from "../lib/site.server";
import { createSessionSlot, sessionSlotFromUrl, withSessionSlot } from "../lib/session-slot";

export function meta() { return [{ title: "登录 | International TMS" }]; }

export async function loader({ request }: Route.LoaderArgs) {
  const site=siteFromRequest(request); if(site!=="admin")throw redirect(siteLogin(site));
  const sessionSlot=sessionSlotFromUrl(request.url);
  if(!sessionSlot)throw redirect(withSessionSlot("/login",createSessionSlot()));
  if ((await getSessionUser(request))?.site === "admin") throw redirect(withSessionSlot("/admin/portal",sessionSlot));
  return { sessionSlot };
}

export async function action({ request }: Route.ActionArgs) {
  const site=siteFromRequest(request); if(site!=="admin")throw redirect(siteLogin(site));
  const form = await request.formData();
  const email = valueOf(form, "email").toLowerCase();
  const password = valueOf(form, "password");
  const user = await env.DB.prepare(
    `SELECT u.id, u.password_hash, u.failed_login_count, u.locked_until, m.organization_id
       FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = ? AND u.status = 'active' AND m.status = 'active'
        AND EXISTS (
          SELECT 1 FROM membership_roles mr
          JOIN roles r ON r.id=mr.role_id AND r.organization_id=m.organization_id
          WHERE mr.membership_id=m.id
            AND r.status='active'
            AND r.code NOT IN ('warehouse_operator','overseas_warehouse_operator')
        )
      LIMIT 1`,
  ).bind(email).first<{ id: string; password_hash: string; failed_login_count: number; locked_until: string | null; organization_id: string }>();
  if (user && isLoginLocked(user.locked_until)) {
    await writeAudit({ request, action: "auth.locked", resourceType: "session", outcome: "failure", organizationId: user.organization_id, actorUserId: user.id });
    return { error: "登录尝试过多，请 15 分钟后再试", email };
  }
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    if (user) await recordLoginFailure(user.id, user.failed_login_count);
    await writeAudit({ request, action: "auth.login", resourceType: "session", outcome: "failure", metadata: { email } });
    return { error: "邮箱或密码不正确，或该账号不属于管理后台", email };
  }
  await clearLoginFailures(user.id);
  await writeAudit({ request, action: "auth.login", resourceType: "session", organizationId: user.organization_id, actorUserId: user.id });
  const sessionSlot=sessionSlotFromUrl(request.url)||createSessionSlot();
  return redirect(withSessionSlot("/admin/portal",sessionSlot), { headers: { "Set-Cookie": await createSession(user.id, user.organization_id, "admin", null, sessionSlot) } });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return <main className="auth-page"><section className="auth-card">
    <div className="brand-mark">IT</div><p className="eyebrow">INTERNATIONAL TMS</p><h1>欢迎回来</h1><p className="muted">登录运输管理工作台</p>
    {actionData?.error && <div className="alert error">{actionData.error}</div>}
    <Form method="post" action={withSessionSlot("/login",loaderData.sessionSlot)} className="stack"><label className="field"><span>邮箱</span><input name="email" type="email" defaultValue={actionData?.email} required autoComplete="email" /></label><label className="field"><span>密码</span><input name="password" type="password" required autoComplete="current-password" /></label><button className="primary" disabled={busy}>{busy ? "正在登录…" : "登录后台"}</button></Form>
  </section></main>;
}
