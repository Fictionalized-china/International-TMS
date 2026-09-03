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
          <span className="nav-group nav-title">工作台</span>
          <SideLink to="/admin/portal" icon="layout">任务工作台</SideLink>
          <SideLink to="/admin/notifications" icon="bell">
            通知{loaderData.notifications.unreadCount>0&&<b className="nav-badge">{loaderData.notifications.unreadCount>99?"99+":loaderData.notifications.unreadCount}</b>}
          </SideLink>
          {can("dashboard.view") && <SideLink to="/admin" icon="dashboard" end>运营总览</SideLink>}

          <span className="nav-group nav-title">汽运业务</span>
          {can("quote.view") && <SideLink to="/admin/quotations" icon="receipt">询价与报价</SideLink>}
          {can("order.view") && <SideLink to="/admin/orders" icon="clipboard">运输订单</SideLink>}
          {can("shipment.view") && <SideLink to="/admin/domestic-tracking" icon="map">在途车辆</SideLink>}
          {can("order.module.loading.manage") && <SideLink to="/admin/loading" icon="truck">配载单跟踪</SideLink>}
          {can("order.module.documents.manage") && <SideLink to="/admin/documents" icon="documents">文件中心</SideLink>}
          {can("shipment.view") && <SideLink to="/admin/shipments" icon="packageCheck">运单列表</SideLink>}
          {can("billing.view") && <SideLink to="/admin/billing" icon="billing">费用结算</SideLink>}
          {can("order.module.cargo.manage") && <SideLink to="/admin/cargo" icon="boxes">货物信息</SideLink>}

          <span className="nav-group nav-title">业务资料</span>
          {can("customer.view") && <SideLink to="/admin/customers" icon="building">客户管理</SideLink>}
          {can("sales.view") && <SideLink to="/admin/sales" icon="chart">销售管理</SideLink>}
          {can("pricing.view") && <SideLink to="/admin/logistics-products" icon="briefcase">物流产品</SideLink>}
          {can("carrier.view") && <SideLink to="/admin/carriers" icon="truck">承运商管理</SideLink>}
          {can("workflow.view") && <SideLink to="/admin/workflow" icon="workflow">业务工作流</SideLink>}

          <span className="nav-group nav-title">系统</span>
          {can("master.view") && <SideLink to="/admin/master-data" icon="settings">基础数据</SideLink>}
          {can("warehouse.manage") && <SideLink to="/admin/warehouses" icon="warehouse">仓库管理</SideLink>}
          {can("department.view") && <SideLink to="/admin/departments" icon="users">部门管理</SideLink>}
          {can("user.view") && <SideLink to="/admin/positions" icon="userSettings">岗位管理</SideLink>}
          {can("user.view") && <SideLink to="/admin/users" icon="users">用户管理</SideLink>}
          {can("role.view") && <SideLink to="/admin/roles" icon="shield">角色权限</SideLink>}
          {can("security.manage") && <SideLink to="/admin/security" icon="lock">安全中心</SideLink>}
          {can("audit.view") && <SideLink to="/admin/audit" icon="history">审计日志</SideLink>}
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
          {can("warehouse.view") && <Form action="/switch-site" method="post" className="sidebar-warehouse-switch">
            <input type="hidden" name="target" value="warehouse" />
            <button title="使用当前账号进入已绑定仓库"><AppIcon name="warehouse" size={15} />登录仓库管理</button>
          </Form>}
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
