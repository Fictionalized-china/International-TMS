import { Form, NavLink, Outlet } from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/dashboard";
import { requireSessionUser } from "../lib/auth.server";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PrototypeBrandMark } from "../components/PrototypeBrandMark";
import { ConnectionStatus } from "../components/InteractionFeedback";
import { InternalNotificationCenter } from "../components/InternalNotificationCenter";
import { WorkspacePreferences } from "../components/WorkspacePreferences";
import { loadInternalNotificationSummary } from "../lib/internal-notifications.server";
import {
  adminNavigationGroupVisibility,
  adminNavigationItemVisibility,
} from "../lib/admin-navigation";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  return {
    user,
    notifications:await loadInternalNotificationSummary(user.organizationId,user.userId),
  };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const can = (permission: string) => user.permissions.includes(permission);
  const navigationGroups = adminNavigationGroupVisibility(user);
  const navigationItems = adminNavigationItemVisibility(user);
  const organizationAccessHref = can("department.view")
    ? "/admin/departments"
    : can("user.view")
      ? "/admin/positions"
      : can("role.view")
        ? "/admin/roles"
        : null;

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
          <SideNavGroup label="工作台" visible={navigationGroups.workbench}>
            {navigationItems.portal && <SideLink to="/admin/portal" icon="layout">任务工作台</SideLink>}
            {navigationItems.notifications && <SideLink to="/admin/notifications" icon="bell">
              通知{loaderData.notifications.unreadCount>0&&<b className="nav-badge">{loaderData.notifications.unreadCount>99?"99+":loaderData.notifications.unreadCount}</b>}
            </SideLink>}
            {navigationItems.dashboard && <SideLink to="/admin" icon="dashboard" end>运营总览</SideLink>}
          </SideNavGroup>

          <SideNavGroup label="运营控制" visible={navigationGroups.control}>
          {navigationItems.trackingCenter && <SideLink to="/admin/tracking-center" icon="map">调度与运踪</SideLink>}
          {navigationItems.analytics && <SideLink to="/admin/analytics" icon="chart">汇总分析</SideLink>}
          </SideNavGroup>

          <SideNavGroup label="汽运业务" visible={navigationGroups.transport}>
          {navigationItems.quotations && <SideLink to="/admin/quotations" icon="receipt">询价与报价</SideLink>}
          {navigationItems.orders && <SideLink to="/admin/orders" icon="clipboard">订单中心</SideLink>}
          {navigationItems.loading && <SideLink to="/admin/loading" icon="truck">配载单跟踪</SideLink>}
          {navigationItems.documents && <SideLink to="/admin/documents" icon="documents">文件中心</SideLink>}
          {navigationItems.shipments && <SideLink to="/admin/shipments" icon="packageCheck">运输单据</SideLink>}
          {navigationItems.billing && <SideLink to="/admin/billing" icon="billing">费用结算</SideLink>}
          {navigationItems.cargo && <SideLink to="/admin/cargo" icon="boxes">货物信息</SideLink>}
          </SideNavGroup>

          <SideNavGroup label="业务资料" visible={navigationGroups.businessData}>
          {navigationItems.customers && <SideLink to="/admin/customers" icon="building">客户管理</SideLink>}
          {navigationItems.sales && <SideLink to="/admin/sales" icon="chart">销售管理</SideLink>}
          {navigationItems.logisticsProducts && <SideLink to="/admin/logistics-products" icon="briefcase">物流产品</SideLink>}
          {navigationItems.carriers && <SideLink to="/admin/carriers" icon="truck">承运商管理</SideLink>}
          {navigationItems.workflow && <SideLink to="/admin/workflow" icon="workflow">业务工作流</SideLink>}
          </SideNavGroup>

          <SideNavGroup label="系统" visible={navigationGroups.system}>
          {navigationItems.masterData && <SideLink to="/admin/master-data" icon="settings">基础数据</SideLink>}
          {navigationItems.warehouses && <SideLink to="/admin/warehouses" icon="warehouse">仓库管理</SideLink>}
          {navigationItems.organizationAccess && organizationAccessHref && <SideLink to={organizationAccessHref} icon="userSettings">组织与权限</SideLink>}
          {navigationItems.security && <SideLink to="/admin/security" icon="lock">安全中心</SideLink>}
          {navigationItems.audit && <SideLink to="/admin/audit" icon="history">审计日志</SideLink>}
          </SideNavGroup>
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

function SideNavGroup({
  label,
  visible,
  children,
}: {
  label: string;
  visible: boolean;
  children: ReactNode;
}) {
  if (!visible) return null;
  return <>
    <span className="nav-group nav-title">{label}</span>
    {children}
  </>;
}

function SideLink({
  to,
  icon,
  end,
  children,
}: {
  to: string;
  icon: AppIconName;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink to={to} end={end}>
      <span className="nav-icon"><AppIcon name={icon} size={17} /></span>
      <span>{children}</span>
    </NavLink>
  );
}
