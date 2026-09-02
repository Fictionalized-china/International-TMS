import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.pickup";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { advanceOverseasOrder } from "../lib/overseas-warehouse.server";
import { Modal } from "../components/Modal";
import { valueOf } from "../lib/validation";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { formatPickupAppointment } from "../lib/pickup-appointment";

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
  notified_at: string | null;
  appointment_at: string | null;
  appointment_period: string | null;
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
               op.notified_at,op.appointment_at,op.appointment_period,op.pickup_at,op.status operation_status,
              COUNT(p.id) package_count,
              SUM(CASE WHEN p.status='allocated' THEN 1 ELSE 0 END) scanned_count,
              SUM(CASE WHEN p.status='dispatched' THEN 1 ELSE 0 END) dispatched_count
         FROM overseas_warehouse_operations op
         JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
         JOIN customers c ON c.id=o.customer_id
         JOIN transport_batches b ON b.id=op.batch_id AND b.organization_id=op.organization_id
         LEFT JOIN shipments s ON s.order_id=o.id AND s.organization_id=o.organization_id
         LEFT JOIN warehouse_packages p ON p.shipment_id=s.id AND p.organization_id=s.organization_id AND p.warehouse_id=op.warehouse_id
         WHERE op.organization_id=? AND op.warehouse_id=? AND op.status IN ('notified','appointment','picked_up')
         GROUP BY op.order_id,o.order_number,c.name,b.batch_number,op.notified_at,op.appointment_at,op.appointment_period,op.pickup_at,op.status
         ORDER BY CASE WHEN op.status IN ('notified','appointment') THEN 0 ELSE 1 END,op.notified_at DESC
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
  const intent=valueOf(form,"intent")||"scan";
  if(intent==="confirm_pickup"){
    const orderId=valueOf(form,"orderId");
    const pickup=await env.DB.prepare(`SELECT op.order_id,o.order_number,COALESCE(o.consignee_contact,o.shipper_contact,(SELECT cc.name FROM customer_contacts cc WHERE cc.customer_id=o.customer_id ORDER BY cc.is_primary DESC,cc.updated_at DESC LIMIT 1),'客户自提') pickup_contact,op.status operation_status
      FROM overseas_warehouse_operations op JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.warehouse_id=? AND op.order_id=? AND op.status!='cancelled' ORDER BY op.created_at DESC LIMIT 1`).bind(user.organizationId,warehouse.id,orderId).first<{order_id:string;order_number:string;pickup_contact:string;operation_status:string}>();
    if(!pickup)return{formError:"未找到当前境外仓的待自提订单"};
    if(!["notified","appointment"].includes(pickup.operation_status))return{formError:"订单当前状态不能确认自提出库"};
    const packageStats=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN p.status='allocated' THEN 1 ELSE 0 END) scanned,SUM(CASE WHEN p.status='exception' THEN 1 ELSE 0 END) exceptions
      FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.status!='dispatched'`).bind(user.organizationId,warehouse.id,orderId).first<{total:number;scanned:number|null;exceptions:number|null}>();
    if(!packageStats?.total||packageStats.scanned!==packageStats.total)return{formError:`${pickup.order_number} 尚未扫描全部货物标签，不能确认出库`};
    if((packageStats.exceptions??0)>0)return{formError:`${pickup.order_number} 仍有异常货物，不能确认出库`};
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,operator_user_id,notes,occurred_at,created_at)
        SELECT lower(hex(randomblob(16))),p.organization_id,p.id,'dispatch',p.location_id,NULL,?,'境外目的仓客户自提复核后出库',?,?
        FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
        WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.status='allocated'`).bind(user.userId,now,now,user.organizationId,warehouse.id,orderId),
      env.DB.prepare(`UPDATE warehouse_packages SET status='dispatched',updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='allocated' AND shipment_id IN (SELECT id FROM shipments WHERE organization_id=? AND order_id=?)`).bind(now,user.organizationId,warehouse.id,user.organizationId,orderId),
    ]);
    await advanceOverseasOrder({organizationId:user.organizationId,orderId,actorUserId:user.userId,action:"pickup",occurredAt:now,pickupContact:pickup.pickup_contact,pickupProofReference:`WAREHOUSE-CONFIRM:${pickup.order_number}`,notes:`${warehouse.name} 已核对整票货物并完成客户自提出库`});
    await writeAudit({request,action:"warehouse.overseas.pickup",resourceType:"transport_order",resourceId:orderId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderNumber:pickup.order_number,confirmedPackages:packageStats.total}});
    const params=new URLSearchParams({warehouseId:warehouse.id,pickupResult:`${pickup.order_number} 已复核并完成自提签收，订单进入费用结算`});
    return redirect(`/warehouse/pickup?${params.toString()}`);
  }
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
  if (!["notified", "appointment"].includes(pkg.operation_status))
    return { formError: `${pkg.order_number} 尚未完成到仓通知，当前不能办理客户自提出库` };
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

  const params = new URLSearchParams({
    warehouseId: warehouse.id,
    orderId:pkg.order_id,
    pickupResult: `${pkg.order_number} 全部货物标签已扫描，请核对货物明细后确认自提出库`,
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
  const readyToConfirm = Boolean(
    loaderData.activeOrder &&
    loaderData.packages.length > 0 &&
    loaderData.packages.every((item) => item.status === "allocated"),
  );
  return <>
    <header className="page-header overseas-pickup-header">
      <div>
        <p className="eyebrow">CUSTOMER PICKUP &amp; SIGN-OFF</p>
        <h1>客户扫码自提签收</h1>
        <p>客户到仓后逐件扫描货物条码；全部扫描完成后核对货物并确认收货，一次完成自提出库与签收。</p>
      </div>
    </header>
    {loaderData.result && !readyToConfirm && <p className="alert success">{loaderData.result}</p>}
    {actionData?.formError && <p className="alert warning">{actionData.formError}</p>}
    <section className="panel overseas-pickup-scan-panel">
      <Form method="post" className="scan-inline overseas-pickup-scan-form">
        <input type="hidden" name="intent" value="scan"/>
        <label className="field">
          <span>扫描境外仓货物条码</span>
          <input name="barcode" placeholder="扫描货物条码后回车" autoComplete="off" autoFocus required />
        </label>
        <button className="primary warehouse-primary" disabled={busy}>{busy ? "正在核对" : "确认扫描"}</button>
      </Form>
      <small>订单号仅用于查询；自提出库必须逐件扫描货物条码，全部扫描后由客户在弹窗内确认收货。</small>
    </section>

    {loaderData.activeOrder && <section className="panel overseas-pickup-progress-panel">
      <div className="panel-header"><div><h2>{loaderData.activeOrder.order_number}</h2><p>{loaderData.activeOrder.customer_name} · {loaderData.activeOrder.batch_number}</p><span className={`pickup-status-summary ${loaderData.activeOrder.appointment_at ? "appointed" : ""}`}><b>预约状态</b>{formatPickupAppointment(loaderData.activeOrder.appointment_at, loaderData.activeOrder.appointment_period)}</span></div><strong>{loaderData.activeOrder.scanned_count}/{loaderData.activeOrder.package_count} 已扫描</strong></div>
      <div className="table-wrap"><table><thead><tr><th>货物标签</th><th>包装号</th><th>件数</th><th>重量 / 体积</th><th>状态</th></tr></thead><tbody>
        {loaderData.packages.map((item) => <tr key={item.id}><td><strong>{item.barcode}</strong></td><td>{item.package_number}</td><td>{item.pieces}</td><td>{item.weight_kg ?? "—"} KG · {item.volume_cbm ?? "—"} CBM</td><td><span className={`status-pill ${item.status === "exception" ? "danger" : ""}`}>{packageStatusLabels[item.status] || item.status}</span></td></tr>)}
      </tbody></table></div>
      {readyToConfirm&&<Modal title={`核对货物并确认收货 · ${loaderData.activeOrder.order_number}`} openSignal={loaderData.result||loaderData.activeOrder.order_id} size="wide"><div className="stack"><div className="alert warning">请客户当面核对订单、客户和下列全部货物条码。点击“确认收货”后，系统将立即完成自提出库与签收。</div><div className="table-wrap"><table><thead><tr><th>货物条码</th><th>包装号</th><th>件数</th><th>重量 / 体积</th></tr></thead><tbody>{loaderData.packages.map(item=><tr key={item.id}><td><strong>{item.barcode}</strong></td><td>{item.package_number}</td><td>{item.pieces}</td><td>{item.weight_kg??"—"} KG · {item.volume_cbm??"—"} CBM</td></tr>)}</tbody></table></div><Form method="post" className="overseas-pickup-confirm-form"><input type="hidden" name="intent" value="confirm_pickup"/><input type="hidden" name="orderId" value={loaderData.activeOrder.order_id}/><button className="primary" disabled={busy}>确认收货</button></Form></div></Modal>}
    </section>}

    <section className="panel overseas-pickup-queue-panel">
      <div className="panel-header"><div><h2>境外仓自提队列</h2><p>统一显示已入库待自提和已自提出库的订单。</p></div><span className="status-pill">{loaderData.orders.length} 票</span></div>
      <div className="table-wrap"><table><thead><tr><th>货物状态</th><th>订单 / 配载单</th><th>客户</th><th>通知时间</th><th>客户预约</th><th>标签进度</th><th>自提出库时间</th></tr></thead><tbody>
        {loaderData.orders.map((item) => <tr key={item.order_id}><td><span className={`status-pill ${item.operation_status === "picked_up" ? "" : "off"}`}>{item.operation_status === "picked_up" ? "已自提出库" : "已入库待自提"}</span></td><td><strong>{item.order_number}</strong><small>{item.batch_number}</small></td><td>{item.customer_name}</td><td>{item.notified_at ? new Date(item.notified_at).toLocaleString("zh-CN") : "客户已通知"}</td><td><span className={`pickup-status-summary compact ${item.appointment_at ? "appointed" : ""}`}>{formatPickupAppointment(item.appointment_at, item.appointment_period)}</span></td><td>{item.dispatched_count}/{item.package_count} 已出库</td><td>{item.pickup_at ? new Date(item.pickup_at).toLocaleString("zh-CN") : "—"}</td></tr>)}
        {!loaderData.orders.length && <tr><td colSpan={7} className="empty-state">当前仓库暂无待自提订单。</td></tr>}
      </tbody></table></div>
    </section>
  </>;
}

export function meta() {
  return [{ title: "客户扫码自提签收 | International TMS" }];
}
