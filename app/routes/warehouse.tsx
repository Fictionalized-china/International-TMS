import { Form, Link, NavLink, Outlet } from "react-router";
import { env } from "cloudflare:workers";
import type { Route } from "./+types/warehouse";
import { requireSessionUser } from "../lib/auth.server";
import { listOrderModules } from "../lib/order-modules.server";
import { checkOrderLoadPlan } from "../lib/order-readiness.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { warehouseRoleLabels } from "../lib/road-master-data";
import { AppIcon } from "../components/AppIcon";

type WarehouseOrder = {
  id: string;
  order_number: string;
  customer_name: string;
  status: string;
  business_type: string;
};

type WarehouseFlow = {
  received: boolean;
  inboundReady: boolean;
  loadPlanReady: boolean;
  loadPlanReasons: string[];
  dispatchStatus: string | null;
};

function safeAdminReturn(value: string | null, orderId: string | null) {
  if (
    value &&
    (value === "/admin" ||
      value.startsWith("/admin/") ||
      value.startsWith("/admin?")) &&
    !value.startsWith("//")
  )
    return value;
  return orderId ? `/admin/orders/${orderId}/modules/warehouse` : "/admin";
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;

  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId");
  const returnTo = safeAdminReturn(url.searchParams.get("returnTo"), orderId);
  let orderContext: (WarehouseOrder & {
    module: Awaited<ReturnType<typeof listOrderModules>>[number] | null;
  }) | null = null;
  let warehouseFlow: WarehouseFlow | null = null;
  if (orderId) {
    const order = await env.DB.prepare(
      `SELECT o.id,o.order_number,c.name customer_name,o.status,o.business_type
       FROM transport_orders o JOIN customers c ON c.id=o.customer_id
       WHERE o.id=? AND o.organization_id=?`,
    )
      .bind(orderId, user.organizationId)
      .first<WarehouseOrder>();
    if (order) {
      const [modules, operational, loadPlan] = await Promise.all([
        listOrderModules(user.organizationId, order.id),
        env.DB.prepare(
          `SELECT
             EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=? AND r.warehouse_id=?) received,
             EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=? AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1) inbound_ready,
             (SELECT d.status FROM warehouse_dispatches d JOIN shipments s ON s.id=d.shipment_id WHERE d.organization_id=? AND s.order_id=? ORDER BY d.created_at DESC LIMIT 1) dispatch_status`,
        ).bind(user.organizationId,order.id,warehouse.id,user.organizationId,order.id,warehouse.id,user.organizationId,order.id).first<{received:number;inbound_ready:number;dispatch_status:string|null}>(),
        checkOrderLoadPlan(user.organizationId, order.id),
      ]);
      orderContext = {
        ...order,
        module: modules.find((item) => item.module_code === (warehouse.warehouse_role === "overseas_destination" ? "overseas_warehouse" : "warehouse")) ?? null,
      };
      warehouseFlow = {
        received:Boolean(operational?.received),
        inboundReady:Boolean(operational?.inbound_ready),
        loadPlanReady:loadPlan.ready,
        loadPlanReasons:loadPlan.reasons,
        dispatchStatus:operational?.dispatch_status ?? null,
      };
    }
  }
  const preserved = new URLSearchParams();
  preserved.set("warehouseId", warehouse.id);
  if (orderContext) preserved.set("orderId", orderContext.id);
  if (returnTo !== "/admin") preserved.set("returnTo", returnTo);
  const query = preserved.toString();
  return {
    user,
    warehouses: warehouseContext.warehouses,
    warehouse,
    warehouseName: warehouse.name,
    currentPath: url.pathname,
    orderContext,
    warehouseFlow,
    returnTo,
    query,
    result: url.searchParams.get("warehouseResult"),
    error: url.searchParams.get("warehouseError"),
  };
}

function warehouseLink(path: string, query: string) {
  return query ? `${path}?${query}` : path;
}

function warehouseReturnLabel(returnTo: string, hasOrderContext: boolean) {
  if (!hasOrderContext) return "返回管理后台";
  if (returnTo.includes("/modules/loading")) return "返回装车与出库";
  if (returnTo.includes("/modules/overseas_warehouse")) return "返回境外仓办理";
  return "返回订单仓库模块";
}

export default function WarehouseLayout({ loaderData }: Route.ComponentProps) {
  const { user, orderContext } = loaderData;
  const module = orderContext?.module;
  const flow = loaderData.warehouseFlow;
  return (
    <div className="warehouse-shell warehouse-app-shell">
      <a className="skip-link" href="#warehouse-main-content">跳到仓库作业</a>
      <aside className="warehouse-sidebar">
        <div className="warehouse-brand">
          <span className="brand-mark small warehouse-mark"><AppIcon name="warehouse" size={18} /></span>
          <div>
            <strong>{loaderData.warehouseName}</strong>
            <small>新翎航 TMS · 仓库作业端</small>
          </div>
        </div>
        <div className="warehouse-context-switcher warehouse-account-context">
          <strong>{warehouseRoleLabels[loaderData.warehouse.warehouse_role]}</strong>
          <small>{loaderData.warehouse.code} · 当前账号绑定仓库</small>
        </div>
        <nav aria-label="仓库作业导航">
          <span className="warehouse-nav-group">现场作业</span>
          <NavLink to={warehouseLink("/warehouse", loaderData.query)} end>
            <span><AppIcon name="dashboard" size={17} /></span>仓库作业总表
          </NavLink>
          <NavLink to={warehouseLink(
            loaderData.warehouse.warehouse_role === "overseas_destination"
              ? "/warehouse/inbound"
              : "/warehouse/acceptance",
            loaderData.query,
          )}>
            <span><AppIcon name="clipboardCheck" size={17} /></span>验收收货
          </NavLink>
          {loaderData.warehouse.warehouse_role !== "overseas_destination" && (
            <NavLink to={warehouseLink("/warehouse/consolidation", loaderData.query)}>
              <span><AppIcon name="boxes" size={17} /></span>货物配载
            </NavLink>
          )}
          {loaderData.warehouse.warehouse_role !== "overseas_destination" && (
            <NavLink to={warehouseLink("/warehouse/ltl-loading", loaderData.query)}>
              <span><AppIcon name="truck" size={17} /></span>拼车装货
            </NavLink>
          )}
          {loaderData.warehouse.warehouse_role !== "overseas_destination" && (
            <NavLink to={warehouseLink("/warehouse/outbound", loaderData.query)}>
              <span><AppIcon name="packageCheck" size={17} /></span>待装车与出库
            </NavLink>
          )}
          {loaderData.warehouse.warehouse_role === "overseas_destination" && (
            <NavLink to={warehouseLink("/warehouse/pickup", loaderData.query)}>
              <span><AppIcon name="packageCheck" size={17} /></span>客户自提出库
            </NavLink>
          )}
          <span className="warehouse-nav-group">库存管理</span>
          <NavLink to={warehouseLink("/warehouse/inventory", loaderData.query)}>
            <span><AppIcon name="archive" size={17} /></span>仓库货物与盘点
          </NavLink>
          <NavLink to={warehouseLink("/warehouse/exceptions", loaderData.query)}>
            <span><AppIcon name="shield" size={17} /></span>异常处理
          </NavLink>
          <span className="warehouse-nav-group">仓储配置</span>
          <NavLink to={warehouseLink("/warehouse/locations", loaderData.query)}>
            <span><AppIcon name="warehouse" size={17} /></span>仓库与库位
          </NavLink>
        </nav>
        <div className="warehouse-site-actions">
          <Form action={`/switch-site?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`} method="post">
            <input type="hidden" name="target" value="admin" />
            <input type="hidden" name="returnTo" value={loaderData.returnTo} />
            <button className="warehouse-return" title="切换回运营管理后台">
              <AppIcon name="layout" size={16} />
              {warehouseReturnLabel(loaderData.returnTo, Boolean(orderContext))}
            </button>
          </Form>
        </div>
        <div className="warehouse-user">
          <span className="warehouse-avatar">
            {user.displayName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </div>
          <Form action={`/logout?site=warehouse&warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`} method="post">
            <button className="warehouse-logout" title="退出登录" aria-label="退出登录"><AppIcon name="logout" size={17} /></button>
          </Form>
        </div>
      </aside>
      <div className="warehouse-main-column">
        <header className="warehouse-topbar">
          <div><AppIcon name="warehouse" size={17} /><strong>{warehouseRoleLabels[loaderData.warehouse.warehouse_role]}</strong><span>{loaderData.warehouseName}</span></div>
          <div><span className="warehouse-sync-state"><i />仓库数据同步正常</span><span className="warehouse-topbar-user"><span className="warehouse-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>当前账号绑定本仓</small></span></span></div>
        </header>
      <main className="warehouse-content" id="warehouse-main-content">
        {orderContext && (
          <section className="warehouse-order-context">
            <div>
              <span>当前联动订单</span>
              <strong>{orderContext.order_number} · {orderContext.customer_name}</strong>
              <small>
                仓库作业：{module?.current_step_name ?? "未启用"} · {module?.progress_percent ?? 0}%
              </small>
            </div>
            <div className="warehouse-order-progress">
              <i style={{ width: `${module?.progress_percent ?? 0}%` }} />
            </div>
            <div className="warehouse-context-steps">
              <span className={flow?.received ? "done" : "active"}>1 {loaderData.warehouse.warehouse_role === "overseas_destination" ? "目的仓扫码入库" : "到仓收货"}</span>
              <span className={flow?.inboundReady ? "done" : flow?.received ? "active" : ""}>2 {loaderData.warehouse.warehouse_role === "overseas_destination" ? "清点确认" : "确认货齐"}</span>
            </div>
            {!flow?.received ? (
              <Link className="primary" to={warehouseLink(loaderData.warehouse.warehouse_role === "overseas_destination" ? "/warehouse/inbound" : "/warehouse/acceptance", loaderData.query)}>去验收收货</Link>
            ) : !flow.inboundReady ? (
              <Link className="primary" to={warehouseLink(loaderData.warehouse.warehouse_role === "overseas_destination" ? "/warehouse/inbound" : "/warehouse/acceptance", loaderData.query)}>{loaderData.warehouse.warehouse_role === "overseas_destination" ? "继续验收并完成清点" : "继续验收并确认货齐"}</Link>
            ) : loaderData.warehouse.warehouse_role === "overseas_destination" ? (
              <Form action={`/switch-site?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`} method="post">
                <input type="hidden" name="target" value="admin" />
                <input type="hidden" name="returnTo" value={`/admin/orders/${orderContext.id}/modules/overseas_warehouse#module-business-data`} />
                <button className="primary">清点完成并已自动通知，返回订单</button>
              </Form>
            ) : loaderData.currentPath.startsWith("/warehouse/outbound") ? (
              <div className="warehouse-context-next">
                <strong>
                  {flow.dispatchStatus === "dispatched"
                    ? "本单已完成装车出库"
                    : flow.dispatchStatus === "loading"
                      ? "当前办理：继续本单装车任务"
                      : "下一步：新建本单装车任务"}
                </strong>
                <small>
                  {flow.dispatchStatus === "dispatched"
                    ? "仓库交接已经完成，无需再次创建装车任务。"
                    : flow.dispatchStatus === "loading"
                      ? "请在本页装车任务中继续扫码并完成出库交接。"
                      : "请点击本页右上角按钮，系统会自动读取整车运输方案。"}
                </small>
              </div>
            ) : (
              <Form action={`/switch-site?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`} method="post">
                <input type="hidden" name="target" value="admin" />
                <input type="hidden" name="returnTo" value={`/admin/orders/${orderContext.id}/modules/loading#module-business-data`} />
                <button className="primary">货齐已确认，进入装车与出库</button>
              </Form>
            )}
          </section>
        )}
        {loaderData.result && <div className="alert success">{loaderData.result}</div>}
        {loaderData.error && <div className="alert error">{loaderData.error}</div>}
        <Outlet />
      </main>
      </div>
    </div>
  );
}
