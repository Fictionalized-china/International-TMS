import { env } from "cloudflare:workers";
import { Outlet } from "react-router";
import type { Route } from "./+types/portal";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import {
  PortalForm,
  PortalNavLink,
  PortalSessionBoundary,
} from "../components/PortalNavigation";
import { PrototypeBrandMark } from "../components/PrototypeBrandMark";
import { ConnectionStatus } from "../components/InteractionFeedback";
import { WorkspacePreferences } from "../components/WorkspacePreferences";
import { portalContextIdFromRequest } from "../lib/portal-session-context";
import { requirePortalCustomer } from "../lib/portal.server";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const contextId = portalContextIdFromRequest(request);
  if (!contextId) throw new Response("客户门户窗口上下文缺失", { status: 400 });
  const row = await env.DB.prepare(
    "SELECT COUNT(*) count FROM portal_notifications WHERE organization_id=? AND customer_id=? AND (user_id IS NULL OR user_id=?) AND is_read=0",
  )
    .bind(user.organizationId, customer.id, user.userId)
    .first<{ count: number }>();
  return { user, customer, contextId, unread: row?.count ?? 0 };
}

export default function PortalLayout({ loaderData }: Route.ComponentProps) {
  const { user, customer, contextId, unread } = loaderData;
  return (
    <PortalSessionBoundary contextId={contextId}><div className="portal-shell prototype-portal-shell">
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
          <strong>{customer.name}</strong>
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
            通知{unread > 0 && <b className="nav-badge">{unread > 99 ? "99+" : unread}</b>}
          </PortalLink>
          <PortalLink to="/portal/account" icon="userSettings">账户中心</PortalLink>
        </nav>
        <div className="portal-user userbox">
          <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <div><strong>{user.displayName}</strong><small>客户门户用户</small></div>
          <PortalForm action="/logout?site=portal" method="post">
            <button className="portal-logout" title="退出登录" aria-label="退出登录"><AppIcon name="logout" size={17} /></button>
          </PortalForm>
        </div>
      </aside>
      <div className="portal-main-column">
        <header className="portal-app-topbar topbar">
          <div className="workspace-switch"><span className="active"><AppIcon name="layout" size={14} />客户门户</span></div>
          <div className="top-actions"><ConnectionStatus className="portal-sync-state" /><WorkspacePreferences /><span className="top-user"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{customer.name}</small></span></span></div>
        </header>
        <main className="portal-content" id="portal-main-content"><Outlet /></main>
      </div>
    </div></PortalSessionBoundary>
  );
}

function PortalLink({ to, icon, end, children }: { to: string; icon: AppIconName; end?: boolean; children: React.ReactNode }) {
  return <PortalNavLink to={to} end={end}><span className="nav-icon"><AppIcon name={icon} size={17} /></span><span>{children}</span></PortalNavLink>;
}
