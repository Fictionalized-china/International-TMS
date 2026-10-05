import { Form, Link, NavLink, Outlet, useLocation } from "react-router";
import { Fragment, type ReactNode } from "react";
import type { Route } from "./+types/dashboard";
import { requireSessionUser } from "../lib/auth.server";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PrototypeBrandMark } from "../components/PrototypeBrandMark";
import { ConnectionStatus } from "../components/InteractionFeedback";
import { InternalNotificationCenter } from "../components/InternalNotificationCenter";
import { WorkspacePreferences } from "../components/WorkspacePreferences";
import { loadInternalNotificationSummary } from "../lib/internal-notifications.server";
import type { AdminNavigationItemKey } from "../lib/admin-navigation";
import { adminPrimaryNavigationGroups, adminPrimaryNavigationItemActive, adminWorkspaceHref } from "../lib/admin-workspace-navigation";

const sideIcons: Record<AdminNavigationItemKey, AppIconName> = {
  portal: "layout", notifications: "bell", dashboard: "dashboard", trackingCenter: "map",
  analytics: "chart", hrReports: "chart", quotations: "receipt", orders: "clipboard",
  loading: "truck", documents: "documents", shipments: "packageCheck", billing: "billing",
  settlementApprovals: "billing", cargo: "boxes", customers: "building", sales: "chart",
  logisticsProducts: "briefcase", carriers: "truck", workflow: "workflow", masterData: "settings",
  warehouses: "warehouse", organizationAccess: "userSettings", security: "lock", audit: "history",
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  return {
    user,
    notifications:await loadInternalNotificationSummary(user.organizationId,user.userId),
  };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const location = useLocation();
  const navigationGroups = adminPrimaryNavigationGroups(user);

  return (
    <div className="shell admin-app-shell">
      <a className="skip-link" href="#admin-main-content">跳到业务内容</a>
      <aside className="sidebar admin-sidebar">
        <div className="brand admin-brand">
          <PrototypeBrandMark />
          <div>
            <strong>新翎航 TMS</strong>
            <small>INTERNATIONAL LOGISTICS</small>
          </div>
        </div>

        <div className="admin-scope-card scope">
          <span>当前工作空间</span>
          <strong>国际汽运运营中心</strong>
          <small>{user.displayName} · 数据按岗位范围显示</small>
        </div>

        <nav className="nav" aria-label="运营管理导航">
          {navigationGroups.map(group => <Fragment key={group.key}>
            <span className="nav-group nav-title">{group.label}</span>
            {group.items.map(item => <SideLink key={item.key}
              to={adminWorkspaceHref(item.href, location.search)} icon={sideIcons[item.key]}
              active={adminPrimaryNavigationItemActive(item, location.pathname, location.search)}>
              {item.label}{item.key === "notifications" && loaderData.notifications.unreadCount > 0 &&
                <b className="nav-badge">{loaderData.notifications.unreadCount > 99 ? "99+" : loaderData.notifications.unreadCount}</b>}
            </SideLink>)}
          </Fragment>)}
        </nav>

        <div className="sidebar-user userbox">
          <span className="user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <span>{user.displayName}</span>
            <small>{user.email}</small>
          </div>
          <Form action="/logout?site=admin" method="post">
            <button className="sidebar-logout" title="退出登录" aria-label="退出登录"><AppIcon name="logout" size={17} /></button>
          </Form>
        </div>
      </aside>
      <div className="admin-main-column">
        <header className="admin-topbar topbar">
          <div className="workspace-switch" aria-label="当前工作空间">
            <span className="active"><AppIcon name="panels" size={14} />管理后台</span>
          </div>
          <div className="admin-topbar-actions top-actions">
            <ConnectionStatus className="admin-sync-state" />
            <WorkspacePreferences />
            <InternalNotificationCenter {...loaderData.notifications}/>
            <NavLink className="admin-topbar-link" to="/admin/portal"><AppIcon name="search" size={16} />查找待办</NavLink>
            <span className="admin-topbar-user top-user"><span className="user-avatar avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.positionCode ?? "运营账号"}</small></span></span>
          </div>
        </header>
        <main className="content" id="admin-main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SideLink({
  to,
  icon,
  active,
  children,
}: {
  to: string;
  icon: AppIconName;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
      <span className="nav-icon"><AppIcon name={icon} size={17} /></span>
      <span>{children}</span>
    </Link>
  );
}
