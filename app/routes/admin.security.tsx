import { env } from "cloudflare:workers";
import { Form } from "react-router";
import type { Route } from "./+types/admin.security";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

type SessionRow = { id: string; user_id: string; display_name: string; email: string; site: string; customer_name: string | null; created_at: string; last_seen_at: string; expires_at: string };
type RiskUser = { id: string; display_name: string; email: string; failed_login_count: number; locked_until: string | null };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "security.manage");
  const [sessions, risks] = await Promise.all([
    env.DB.prepare(`SELECT s.id, s.user_id, u.display_name, u.email, s.site, c.name AS customer_name, s.created_at, s.last_seen_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN customer_portal_accounts cpa ON cpa.user_id = u.id AND cpa.organization_id = s.organization_id LEFT JOIN customers c ON c.id = cpa.customer_id WHERE s.organization_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`).bind(current.organizationId, new Date().toISOString()).all<SessionRow>(),
    env.DB.prepare(`SELECT DISTINCT u.id, u.display_name, u.email, u.failed_login_count, u.locked_until FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN customer_portal_accounts cpa ON cpa.user_id = u.id WHERE (m.organization_id = ? OR cpa.organization_id = ?) AND (u.failed_login_count > 0 OR u.locked_until IS NOT NULL) ORDER BY u.failed_login_count DESC`).bind(current.organizationId, current.organizationId).all<RiskUser>(),
  ]);
  return { current, sessions: sessions.results, risks: risks.results };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "security.manage");
  const form = await request.formData(), intent = valueOf(form, "intent"), id = valueOf(form, "id");
  if (intent === "unlock") {
    const result = await env.DB.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ? AND (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = ?) OR EXISTS (SELECT 1 FROM customer_portal_accounts cpa WHERE cpa.user_id = users.id AND cpa.organization_id = ?))`).bind(new Date().toISOString(), id, current.organizationId, current.organizationId).run();
    if (!result.meta.changes) return { formError: "用户不存在" };
    await writeAudit({ request, action: "security.user.unlock", resourceType: "user", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId });
    return { success: "用户登录限制已解除" };
  }
  if (id === current.sessionId) return { formError: "不能在此撤销当前会话，请使用退出登录" };
  const result = await env.DB.prepare("DELETE FROM sessions WHERE id = ? AND organization_id = ?").bind(id, current.organizationId).run();
  if (!result.meta.changes) return { formError: "会话不存在" };
  await writeAudit({ request, action: "security.session.revoke", resourceType: "session", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId });
  return { success: "会话已撤销" };
}

export function meta() { return [{ title: "安全中心 | International TMS" }]; }

export default function Security({ loaderData, actionData }: Route.ComponentProps) {
  const adminSessions = loaderData.sessions.filter(item => item.site === "admin").length, portalSessions = loaderData.sessions.length - adminSessions;
  return <><header className="page-header"><div><p className="eyebrow">SECURITY CENTER</p><h1>权限与安全</h1><p>监控后台和客户门户会话，处理登录风险。</p></div><span className="status-pill">登录保护已启用</span></header>
    <section className="stats"><article><span>后台会话</span><strong>{adminSessions}</strong><small>内部员工</small></article><article><span>门户会话</span><strong>{portalSessions}</strong><small>客户用户</small></article><article><span>风险用户</span><strong>{loaderData.risks.length}</strong><small>失败或锁定</small></article></section>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    <section className="panel"><h2>有效会话</h2><div className="table-wrap"><table><thead><tr><th>用户</th><th>站点</th><th>客户</th><th>创建时间</th><th>到期时间</th><th></th></tr></thead><tbody>{loaderData.sessions.map(session => <tr key={session.id}><td><strong>{session.display_name}</strong><small>{session.email}</small></td><td><span className="status-pill">{session.site === "portal" ? "客户门户" : "后台操作"}</span></td><td>{session.customer_name || "—"}</td><td>{new Date(session.created_at).toLocaleString("zh-CN")}</td><td>{new Date(session.expires_at).toLocaleString("zh-CN")}</td><td>{session.id !== loaderData.current.sessionId && <Form method="post"><input type="hidden" name="intent" value="revoke"/><input type="hidden" name="id" value={session.id}/><button className="text-button danger">撤销</button></Form>}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><h2>登录风险</h2>{loaderData.risks.length ? <div className="table-wrap"><table><thead><tr><th>用户</th><th>失败次数</th><th>锁定到</th><th></th></tr></thead><tbody>{loaderData.risks.map(user => <tr key={user.id}><td><strong>{user.display_name}</strong><small>{user.email}</small></td><td>{user.failed_login_count}</td><td>{user.locked_until ? new Date(user.locked_until).toLocaleString("zh-CN") : "未锁定"}</td><td><Form method="post"><input type="hidden" name="intent" value="unlock"/><input type="hidden" name="id" value={user.id}/><button className="text-button">解除限制</button></Form></td></tr>)}</tbody></table></div> : <p className="empty-state">当前没有登录风险。</p>}</section>
    <section className="panel security-policy"><h2>已启用安全策略</h2><div className="module-list"><div><span className="module-icon done">✓</span><div><strong>双站点会话隔离</strong><p>后台与客户门户会话不可交叉使用。</p></div><span>已启用</span></div><div><span className="module-icon done">✓</span><div><strong>登录失败锁定</strong><p>连续失败 5 次后锁定 15 分钟。</p></div><span>已启用</span></div><div><span className="module-icon done">✓</span><div><strong>组织级数据隔离</strong><p>客户、销售和基础数据均受组织边界保护。</p></div><span>已启用</span></div></div></section>
  </>;
}
