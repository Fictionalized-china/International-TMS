import { Form, NavLink, Outlet } from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/dashboard";
import { requireSessionUser } from "../lib/auth.server";

export async function loader({ request }: Route.LoaderArgs) {
  return { user: await requireSessionUser(request) };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const can = (permission: string) => user.permissions.includes(permission);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand admin-brand">
          <span className="admin-logo">O</span>
          <div>
            <strong>ouling</strong>
            <small>欧凌国际货运代理</small>
          </div>
          <span className="brand-collapse">‹</span>
        </div>

        <nav>
          <span className="nav-group">业务</span>
          <SideLink to="/admin" icon="▣" end>运营总览</SideLink>
          <SideLink to="/admin/portal" icon="◎">岗位门户</SideLink>
          {can("customer.view") && <SideLink to="/admin/customers" icon="◇">客户管理</SideLink>}
          {can("sales.view") && <SideLink to="/admin/sales" icon="▱">销售管理</SideLink>}
          {can("quote.view") && <SideLink to="/admin/quotations" icon="▰">询价报价</SideLink>}
          {can("pricing.view") && <SideLink to="/admin/logistics-products" icon="◈">物流产品</SideLink>}
          {can("billing.view") && <SideLink to="/admin/billing" icon="▤">费用结算</SideLink>}
          {can("workflow.view") && <SideLink to="/admin/workflow" icon="↬">业务工作流</SideLink>}

          <span className="nav-group">汽运业务</span>
          {can("order.view") && <SideLink to="/admin/orders" icon="▣">运输订单</SideLink>}
          {can("shipment.view") && <SideLink to="/admin/shipments" icon="◎">运单列表</SideLink>}
          {can("carrier.view") && <SideLink to="/admin/carriers" icon="▱">承运商管理</SideLink>}
          {can("order.view") && <SideLink to="/admin/workbenches/tasks" icon="◇">业务工作台</SideLink>}
          {can("order.view") && <SideLink to="/admin/loading" icon="▰">拼车配载</SideLink>}
          {can("order.view") && <SideLink to="/admin/cargo" icon="▤">货物信息</SideLink>}

          <span className="nav-group">系统</span>
          {can("master.view") && <SideLink to="/admin/master-data" icon="▦">基础数据</SideLink>}
          {can("warehouse.manage") && <SideLink to="/admin/warehouses" icon="▥">仓库管理</SideLink>}
          {can("department.view") && <SideLink to="/admin/departments" icon="▥">部门管理</SideLink>}
          {can("user.view") && <SideLink to="/admin/positions" icon="▧">岗位管理</SideLink>}
          {can("user.view") && <SideLink to="/admin/users" icon="◉">用户管理</SideLink>}
          {can("role.view") && <SideLink to="/admin/roles" icon="▨">角色权限</SideLink>}
          {can("security.manage") && <SideLink to="/admin/security" icon="↯">安全中心</SideLink>}
          {can("audit.view") && <SideLink to="/admin/audit" icon="▤">审计日志</SideLink>}
        </nav>

        <div className="sidebar-user">
          <span className="user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <span>{user.displayName}</span>
            <small>{user.email}</small>
          </div>
          <Form action="/logout" method="post">
            <button className="sidebar-logout" title="退出登录">↗</button>
          </Form>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
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
  icon: string;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink to={to} end={end}>
      <span className="nav-icon">{icon}</span>
      <span>{children}</span>
    </NavLink>
  );
}
