import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.pickup";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { advanceOverseasOrder } from "../lib/overseas-warehouse.server";
import { valueOf } from "../lib/validation";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";

type PickupPackage = {
  id: string;
  barcode: string;
  package_number: string;
  pieces: number;
  weight_kg: number | null;
  volume_cbm: number | null;
  status: string;
};

type PickupOrder = {
  order_id: string;
  order_number: string;
  customer_name: string;
  batch_number: string;
  appointment_at: string | null;
  pickup_at: string | null;
  operation_status: string;
  package_count: number;
  scanned_count: number;
  dispatched_count: number;
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  if (warehouse.warehouse_role !== "overseas_destination")
    throw new Response("客户自提出库仅供境外目的仓使用", { status: 404 });

  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId") || "";
  const [orders, packages] = await Promise.all([
    env.DB.prepare(
      `SELECT op.order_id,o.order_number,c.name customer_name,b.batch_number,
              op.appointment_at,op.pickup_at,op.status operation_status,
              COUNT(p.id) package_count,
              SUM(CASE WHEN p.status='allocated' THEN 1 ELSE 0 END) scanned_count,
              SUM(CASE WHEN p.status='dispatched' THEN 1 ELSE 0 END) dispatched_count
         FROM overseas_warehouse_operations op
         JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
         JOIN customers c ON c.id=o.customer_id
         JOIN transport_batches b ON b.id=op.batch_id AND b.organization_id=op.organization_id
         LEFT JOIN shipments s ON s.order_id=o.id AND s.organization_id=o.organization_id
         LEFT JOIN warehouse_packages p ON p.shipment_id=s.id AND p.organization_id=s.organization_id AND p.warehouse_id=op.warehouse_id
        WHERE op.organization_id=? AND op.warehouse_id=? AND op.status IN ('appointment','picked_up')
        GROUP BY op.order_id,o.order_number,c.name,b.batch_number,op.appointment_at,op.pickup_at,op.status
        ORDER BY CASE op.status WHEN 'appointment' THEN 0 ELSE 1 END,op.appointment_at DESC
        LIMIT 100`,
    ).bind(user.organizationId, warehouse.id).all<PickupOrder>(),
    orderId
      ? env.DB.prepare(
          `SELECT p.id,p.barcode,p.package_number,p.pieces,p.weight_kg,p.volume_cbm,p.status
             FROM warehouse_packages p
             JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
            WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=?
            ORDER BY p.package_number`,
        ).bind(user.organizationId, warehouse.id, orderId).all<PickupPackage>()
      : Promise.resolve({ results: [] as PickupPackage[] }),
  ]);
  return {
    user,
    warehouse,
    orders: orders.results,
    packages: packages.results,
    activeOrder: orders.results.find((item) => item.order_id === orderId) ?? null,
    result: url.searchParams.get("pickupResult") || "",
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  if (warehouse.warehouse_role !== "overseas_destination")
    return { formError: "客户自提出库仅供境外目的仓使用" };
  await requireWarehouseAssignment(user, warehouse.id, "operator");

  const form = await request.formData();
  const barcode = valueOf(form, "barcode").trim();
  if (!barcode) return { formError: "请扫描境外仓现有货物标签" };

  const orderLookup = await env.DB.prepare(
    `SELECT op.order_id,o.order_number
       FROM overseas_warehouse_operations op
       JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.warehouse_id=? AND o.order_number=? AND op.status!='cancelled'
      ORDER BY op.created_at DESC LIMIT 1`,
  ).bind(user.organizationId, warehouse.id, barcode).first<{
    order_id: string;
    order_number: string;
  }>();
  if (orderLookup) {
    const params = new URLSearchParams({
      warehouseId: warehouse.id,
      orderId: orderLookup.order_id,
      pickupResult: `${orderLookup.order_number} 已调出，请继续逐件扫描下方货物标签`,
    });
    return redirect(`/warehouse/pickup?${params.toString()}`);
  }

  const pkg = await env.DB.prepare(
    `SELECT p.id,p.status,p.location_id,p.barcode,s.order_id,o.order_number,
            COALESCE(
              o.consignee_contact,
              o.shipper_contact,
              (SELECT cc.name
                 FROM customer_contacts cc
                WHERE cc.customer_id=o.customer_id
                ORDER BY cc.is_primary DESC,cc.updated_at DESC
                LIMIT 1),
              '客户自提'
            ) pickup_contact,
            op.status operation_status
       FROM warehouse_packages p
       JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
       JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
       JOIN overseas_warehouse_operations op ON op.order_id=o.id AND op.organization_id=o.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND p.barcode=? AND op.warehouse_id=? AND op.status!='cancelled'
      ORDER BY op.created_at DESC LIMIT 1`,
  ).bind(user.organizationId, warehouse.id, barcode, warehouse.id).first<{
    id: string;
    status: string;
    location_id: string | null;
    barcode: string;
    order_id: string;
    order_number: string;
    pickup_contact: string;
    operation_status: string;
  }>();
  if (!pkg) return { formError: `未找到当前境外仓货物标签：${barcode}` };
  if (pkg.operation_status === "picked_up")
    return { formError: `${pkg.order_number} 已完成客户自提出库，请勿重复扫描` };
  if (pkg.operation_status !== "appointment")
    return { formError: `${pkg.order_number} 尚未登记提货预约，当前不能办理客户自提出库` };
  if (pkg.status === "dispatched")
    return { formError: `${barcode} 已经出库，请勿重复扫描` };
  if (pkg.status === "exception")
    return { formError: `${barcode} 处于异常状态，请先完成异常处理` };

  const stats = await env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN p.status='in_stock' THEN 1 ELSE 0 END) waiting,
            SUM(CASE WHEN p.status='allocated' THEN 1 ELSE 0 END) scanned,
            SUM(CASE WHEN p.status='exception' THEN 1 ELSE 0 END) exceptions
       FROM warehouse_packages p
       JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.status!='dispatched'`,
  ).bind(user.organizationId, warehouse.id, pkg.order_id).first<{
    total: number;
    waiting: number | null;
    scanned: number | null;
    exceptions: number | null;
  }>();
  if ((stats?.exceptions ?? 0) > 0)
    return { formError: `${pkg.order_number} 仍有异常货物，不能完成自提出库` };

  const now = new Date().toISOString();
  if (pkg.status === "in_stock") {
    await env.DB.prepare(
      "UPDATE warehouse_packages SET status='allocated',updated_at=? WHERE id=? AND organization_id=? AND status='in_stock'",
    ).bind(now, pkg.id, user.organizationId).run();
  }
  const remaining = Math.max(0, (stats?.waiting ?? 0) - (pkg.status === "in_stock" ? 1 : 0));
  if (remaining > 0) {
    const params = new URLSearchParams({
      warehouseId: warehouse.id,
      orderId: pkg.order_id,
      pickupResult: `${pkg.order_number} 已扫描 ${((stats?.scanned ?? 0) + 1)}/${stats?.total ?? 0} 个标签，请继续扫描本单剩余货物`,
    });
    return redirect(`/warehouse/pickup?${params.toString()}`);
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO warehouse_package_movements(
         id,organization_id,package_id,operation_type,from_location_id,to_location_id,
         operator_user_id,notes,occurred_at,created_at
       )
       SELECT lower(hex(randomblob(16))),p.organization_id,p.id,'dispatch',p.location_id,NULL,?,?,?,?
         FROM warehouse_packages p
         JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
        WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.status='allocated'`,
    ).bind(
      user.userId,
      "境外目的仓客户自提扫码出库",
      now,
      now,
      user.organizationId,
      warehouse.id,
      pkg.order_id,
    ),
    env.DB.prepare(
      `UPDATE warehouse_packages SET status='dispatched',updated_at=?
        WHERE organization_id=? AND warehouse_id=? AND status='allocated'
          AND shipment_id IN (SELECT id FROM shipments WHERE organization_id=? AND order_id=?)`,
    ).bind(now, user.organizationId, warehouse.id, user.organizationId, pkg.order_id),
  ]);
  await advanceOverseasOrder({
    organizationId: user.organizationId,
    orderId: pkg.order_id,
    actorUserId: user.userId,
    action: "pickup",
    occurredAt: now,
    pickupContact: pkg.pickup_contact,
    pickupProofReference: `WAREHOUSE-SCAN:${barcode}`,
    notes: `${warehouse.name} 已逐件扫码并完成客户自提出库`,
  });
  await writeAudit({
    request,
    action: "warehouse.overseas.pickup",
    resourceType: "transport_order",
    resourceId: pkg.order_id,
    organizationId: user.organizationId,
    actorUserId: user.userId,
    metadata: { warehouseId: warehouse.id, orderNumber: pkg.order_number, barcode },
  });
  const params = new URLSearchParams({
    warehouseId: warehouse.id,
    pickupResult: `${pkg.order_number} 全部货物已扫码出库，管理后台已同步为“客户已自提，待签收确认”`,
  });
  return redirect(`/warehouse/pickup?${params.toString()}`);
}

const packageStatusLabels: Record<string, string> = {
  in_stock: "待扫描",
  allocated: "已扫描",
  dispatched: "已出库",
  exception: "异常",
};

export default function WarehousePickup({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return <>
    <header className="page-header overseas-pickup-header">
      <div>
        <p className="eyebrow">CUSTOMER PICKUP</p>
        <h1>客户自提出库</h1>
        <p>逐件扫描境外仓货物标签；同一订单全部货物扫完后，系统自动同步客户自提状态。</p>
      </div>
    </header>
    {loaderData.result && <p className="alert success">{loaderData.result}</p>}
    {actionData?.formError && <p className="alert warning">{actionData.formError}</p>}
    <section className="panel overseas-pickup-scan-panel">
      <Form method="post" className="scan-inline overseas-pickup-scan-form">
        <label className="field">
          <span>扫描境外仓货物标签</span>
          <input name="barcode" placeholder="扫描货物标签条码后回车" autoComplete="off" autoFocus required />
        </label>
        <button className="primary warehouse-primary" disabled={busy}>{busy ? "正在核对" : "确认扫描"}</button>
      </Form>
      <small>订单号用于查询，出库必须逐件扫描货物标签；全部扫完后自动完成本票自提出库。</small>
    </section>

    {loaderData.activeOrder && <section className="panel overseas-pickup-progress-panel">
      <div className="panel-header"><div><h2>{loaderData.activeOrder.order_number}</h2><p>{loaderData.activeOrder.customer_name} · {loaderData.activeOrder.batch_number}</p></div><strong>{loaderData.activeOrder.scanned_count}/{loaderData.activeOrder.package_count} 已扫描</strong></div>
      <div className="table-wrap"><table><thead><tr><th>货物标签</th><th>包装号</th><th>件数</th><th>重量 / 体积</th><th>状态</th></tr></thead><tbody>
        {loaderData.packages.map((item) => <tr key={item.id}><td><strong>{item.barcode}</strong></td><td>{item.package_number}</td><td>{item.pieces}</td><td>{item.weight_kg ?? "—"} KG · {item.volume_cbm ?? "—"} CBM</td><td><span className={`status-pill ${item.status === "exception" ? "off" : ""}`}>{packageStatusLabels[item.status] || item.status}</span></td></tr>)}
      </tbody></table></div>
    </section>}

    <section className="panel overseas-pickup-queue-panel">
      <div className="panel-header"><div><h2>境外仓自提队列</h2><p>只显示已预约待自提和已完成自提出库的订单。</p></div><span className="status-pill">{loaderData.orders.length} 票</span></div>
      <div className="table-wrap"><table><thead><tr><th>状态</th><th>订单 / 配载单</th><th>客户</th><th>预约时间</th><th>标签进度</th><th>自提出库时间</th></tr></thead><tbody>
        {loaderData.orders.map((item) => <tr key={item.order_id}><td><span className={`status-pill ${item.operation_status === "picked_up" ? "" : "off"}`}>{item.operation_status === "picked_up" ? "已自提待签收" : "待扫码自提"}</span></td><td><strong>{item.order_number}</strong><small>{item.batch_number}</small></td><td>{item.customer_name}</td><td>{item.appointment_at ? new Date(item.appointment_at).toLocaleString("zh-CN") : "—"}</td><td>{item.dispatched_count}/{item.package_count} 已出库</td><td>{item.pickup_at ? new Date(item.pickup_at).toLocaleString("zh-CN") : "—"}</td></tr>)}
        {!loaderData.orders.length && <tr><td colSpan={6} className="empty-state">当前仓库暂无待自提订单。</td></tr>}
      </tbody></table></div>
    </section>
  </>;
}

export function meta() {
  return [{ title: "客户自提出库 | International TMS" }];
}
