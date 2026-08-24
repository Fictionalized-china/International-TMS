import { env } from "cloudflare:workers";
import { Form, NavLink, Outlet } from "react-router";
import type { Route } from "./+types/portal";
import { requireSessionUser } from "../lib/auth.server";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PrototypeBrandMark } from "../components/PrototypeBrandMark";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, undefined, "portal");
  const account = await env.DB.prepare(
    "SELECT customer_id FROM customer_portal_accounts WHERE user_id=? AND organization_id=? AND status='active' LIMIT 1",
  )
    .bind(user.userId, user.organizationId)
    .first<{ customer_id: string }>();
  let unread = 0;
  if (account) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) count FROM portal_notifications WHERE organization_id=? AND customer_id=? AND (user_id IS NULL OR user_id=?) AND is_read=0",
    )
      .bind(user.organizationId, account.customer_id, user.userId)
      .first<{ count: number }>();
    unread = row?.count ?? 0;
  }
  return { user, unread };
}

export default function PortalLayout({ loaderData }: Route.ComponentProps) {
  const { user, unread } = loaderData;
  return (
    <div className="portal-shell prototype-portal-shell">
      <a className="skip-link" href="#portal-main-content">跳到客户门户内容</a>
      <aside className="portal-sidebar">
        <div className="brand portal-brand">
          <PrototypeBrandMark />
          <div>
            <strong>新翎航 TMS</strong>
            <small>CLIENT PORTAL</small>
          </div>
        </div>
        <div className="portal-scope scope">
          <span>当前客户</span>
          <strong>{user.organizationName}</strong>
          <small>订单、轨迹、账单与通知</small>
        </div>
        <nav className="nav" aria-label="客户门户导航">
          <span className="nav-group nav-title">客户门户</span>
          <PortalLink to="/portal" icon="dashboard" end>我的首页</PortalLink>
          <PortalLink to="/portal/calculator" icon="receipt">运费试算</PortalLink>
          <PortalLink to="/portal/orders" icon="clipboard">我的订单</PortalLink>
          <PortalLink to="/portal/tracking" icon="map">运输轨迹</PortalLink>
          <PortalLink to="/portal/billing" icon="billing">账单与文件</PortalLink>
          <PortalLink to="/portal/notifications" icon="documents">
            消息中心{unread > 0 && <b className="nav-badge">{unread > 99 ? "99+" : unread}</b>}
          </PortalLink>
          <PortalLink to="/portal/account" icon="userSettings">账户中心</PortalLink>
        </nav>
        <div className="portal-user userbox">
          <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <div><strong>{user.displayName}</strong><small>客户门户用户</small></div>
          <Form action="/logout?site=portal" method="post">
            <button className="portal-logout" title="退出登录" aria-label="退出登录"><AppIcon name="logout" size={17} /></button>
          </Form>
        </div>
      </aside>
      <div className="portal-main-column">
        <header className="portal-app-topbar topbar">
          <div className="workspace-switch"><span className="active"><AppIcon name="layout" size={14} />客户门户</span></div>
          <div className="top-actions"><span className="portal-sync-state"><i />数据已同步</span><span className="top-user"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.organizationName}</small></span></span></div>
        </header>
        <main className="portal-content" id="portal-main-content"><Outlet /></main>
      </div>
    </div>
  );
}

function PortalLink({ to, icon, end, children }: { to: string; icon: AppIconName; end?: boolean; children: React.ReactNode }) {
  return <NavLink to={to} end={end}><span className="nav-icon"><AppIcon name={icon} size={17} /></span><span>{children}</span></NavLink>;
}
