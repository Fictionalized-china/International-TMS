import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.pickup";
import { QueryPagination } from "../components/QueryPagination";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { advanceOverseasOrder } from "../lib/overseas-warehouse.server";
import { Modal } from "../components/Modal";
import { ActionToast } from "../components/ActionToast";
import { valueOf } from "../lib/validation";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { formatPickupAppointment } from "../lib/pickup-appointment";
import { paginateList, readListPage } from "../lib/list-pagination";
import { canOperateWarehouseUi } from "../lib/warehouse-ui-access";
import { loadOrderModuleWorkflowFields } from "../lib/workflow-fields.server";
import {
  resolvePickupWorkflowPolicy,
  validatePickupWorkflowSubmission,
} from "../lib/warehouse-pickup-workflow-policy";
import {
  loadWarehousePhysicalWorkflowAccess,
  warehousePhysicalWorkflowAccessSql,
  warehousePhysicalWorkflowVisibilitySql,
} from "../lib/warehouse-workflow-access.server";

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
  suggested_pickup_contact: string | null;
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
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const pickupState = url.searchParams.get("pickupState") || "all";
  const requestedPage = readListPage(url.searchParams);
  const workflowGate = warehousePhysicalWorkflowAccessSql(
    "o",
    "overseas_warehouse",
    { userId: user.userId, positionCode: user.positionCode },
  );
  const workflowVisibility = warehousePhysicalWorkflowVisibilitySql(
    "o",
    "overseas_warehouse",
  );
  const [orders, packages] = await Promise.all([
    env.DB.prepare(
      `SELECT op.order_id,o.order_number,c.name customer_name,b.batch_number,
               op.notified_at,op.appointment_at,op.appointment_period,op.pickup_at,op.status operation_status,
               COALESCE(o.consignee_contact,o.shipper_contact,
                 (SELECT cc.name FROM customer_contacts cc WHERE cc.customer_id=o.customer_id ORDER BY cc.is_primary DESC,cc.updated_at DESC LIMIT 1)
               ) suggested_pickup_contact,
               COUNT(p.id) package_count,
              SUM(CASE WHEN p.status='allocated' THEN 1 ELSE 0 END) scanned_count,
              SUM(CASE WHEN p.status='dispatched' THEN 1 ELSE 0 END) dispatched_count
         FROM overseas_warehouse_operations op
         JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
         JOIN customers c ON c.id=o.customer_id
         JOIN transport_batches b ON b.id=op.batch_id AND b.organization_id=op.organization_id
         LEFT JOIN shipments s ON s.order_id=o.id AND s.organization_id=o.organization_id
         LEFT JOIN warehouse_packages p ON p.shipment_id=s.id AND p.organization_id=s.organization_id AND p.warehouse_id=op.warehouse_id AND p.label_kind='oul'
         WHERE op.organization_id=? AND op.warehouse_id=? AND op.status IN ('notified','appointment','picked_up')
           AND (
             (op.status='picked_up' AND ${workflowVisibility.sql})
             OR (op.status IN ('notified','appointment') AND ${workflowGate.sql})
           )
         GROUP BY op.order_id,o.order_number,c.name,b.batch_number,op.notified_at,op.appointment_at,op.appointment_period,op.pickup_at,op.status,o.customer_id,o.consignee_contact,o.shipper_contact
         ORDER BY CASE WHEN op.status IN ('notified','appointment') THEN 0 ELSE 1 END,op.notified_at DESC
         `,
    ).bind(user.organizationId, warehouse.id, ...workflowVisibility.values, ...workflowGate.values).all<PickupOrder>(),
    orderId
      ? env.DB.prepare(
          `SELECT p.id,p.barcode,p.package_number,p.pieces,p.weight_kg,p.volume_cbm,p.status
             FROM warehouse_packages p
             JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
            WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.label_kind='oul'
            ORDER BY p.package_number`,
        ).bind(user.organizationId, warehouse.id, orderId).all<PickupPackage>()
      : Promise.resolve({ results: [] as PickupPackage[] }),
  ]);
  const filteredOrders = orders.results.filter((item) => {
    if (pickupState === "waiting" && item.operation_status === "picked_up") return false;
    if (pickupState === "picked_up" && item.operation_status !== "picked_up") return false;
    if (q && !`${item.order_number} ${item.batch_number} ${item.customer_name}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const pagination = paginateList(filteredOrders, requestedPage);
  const activeOrder = orders.results.find((item) => item.order_id === orderId) ?? null;
  const requestedOrderAccess = orderId && activeOrder?.operation_status !== "picked_up"
    ? await loadWarehousePhysicalWorkflowAccess(
        env.DB,
        user.organizationId,
        orderId,
        "overseas_warehouse",
        { userId: user.userId, positionCode: user.positionCode },
      )
    : null;
  const pickupWorkflowFields = activeOrder && requestedOrderAccess?.available
    ? await loadOrderModuleWorkflowFields(user.organizationId, orderId, "overseas_warehouse")
    : [];
  const pickupWorkflowPolicy = resolvePickupWorkflowPolicy({
    fields: pickupWorkflowFields,
    targetStepKey: requestedOrderAccess?.targetStepKey ?? null,
    legacyFallback: requestedOrderAccess?.legacyFallback ?? false,
  });
  return {
    user,
    warehouse,
    orders: pagination.items,
    warehouseAccessLevel: context.selectedAccessLevel,
    pagination: {
      page: pagination.page,
      pageCount: pagination.pageCount,
      pageSize: pagination.pageSize,
      total: pagination.total,
    },
    filters: { q: url.searchParams.get("q") || "", pickupState },
    packages: activeOrder ? packages.results : [],
    activeOrder,
    pickupWorkflowPolicy,
    workflowGateReason: requestedOrderAccess && !requestedOrderAccess.available
      ? requestedOrderAccess.reason || "当前订单的冻结工作流尚未开放客户自提"
      : "",
    result: url.searchParams.get("pickupResult") || "",
    pickupCompletion: url.searchParams.get("pickupCompleted") === "1"
      ? {
          orderNumber: url.searchParams.get("pickupOrderNumber") || "",
          packageCount: Number(url.searchParams.get("pickupPackageCount") || 0),
        }
      : null,
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
    if (!orderId) return { formError: "请选择待自提订单" };
    const workflowAccess = await loadWarehousePhysicalWorkflowAccess(
      env.DB,
      user.organizationId,
      orderId,
      "overseas_warehouse",
      { userId: user.userId, positionCode: user.positionCode },
    );
    if (!workflowAccess.available)
      return { formError: workflowAccess.reason || "当前订单的冻结工作流尚未开放客户自提" };
    const pickupWorkflowFields = await loadOrderModuleWorkflowFields(
      user.organizationId,
      orderId,
      "overseas_warehouse",
    );
    const pickupWorkflowPolicy = resolvePickupWorkflowPolicy({
      fields: pickupWorkflowFields,
      targetStepKey: workflowAccess.targetStepKey,
      legacyFallback: workflowAccess.legacyFallback,
    });
    const submission = validatePickupWorkflowSubmission(pickupWorkflowPolicy, {
      pickupContact: valueOf(form, "pickupContact"),
      pickupProofReference: valueOf(form, "pickupProofReference"),
    });
    if (submission.error) return { formError: submission.error };
    const pickup=await env.DB.prepare(`SELECT op.order_id,o.order_number,op.status operation_status
      FROM overseas_warehouse_operations op JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.warehouse_id=? AND op.order_id=? AND o.status='in_execution' AND op.status!='cancelled' ORDER BY op.created_at DESC LIMIT 1`).bind(user.organizationId,warehouse.id,orderId).first<{order_id:string;order_number:string;operation_status:string}>();
    if(!pickup)return{formError:"未找到当前境外仓的待自提订单"};
    if(!["notified","appointment"].includes(pickup.operation_status))return{formError:"订单当前状态不能确认自提出库"};
    const packages=(await env.DB.prepare(`SELECT p.id,p.barcode,p.location_id,p.status,p.lifecycle_status
      FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.label_kind='oul' AND p.lifecycle_status='overseas_received' AND p.status!='dispatched'
      ORDER BY p.package_number`).bind(user.organizationId,warehouse.id,orderId).all<{id:string;barcode:string;location_id:string|null;status:string;lifecycle_status:string}>()).results;
    if(!packages.length)return{formError:`${pickup.order_number} 没有可自提的 OUL`};
    if(packages.some(item=>item.status==='exception'))return{formError:`${pickup.order_number} 仍有异常货物，不能确认出库`};
    const scannedCodes=parsePickupCodes(valueOf(form,"scannedOulCodes"));
    const expectedCodes=packages.map(item=>item.barcode.toUpperCase());
    if(scannedCodes.length!==expectedCodes.length||expectedCodes.some(code=>!scannedCodes.includes(code)))return{formError:`必须一次扫齐 ${expectedCodes.length} 个 OUL 后才能确认自提，本次已扫 ${scannedCodes.length} 个`};
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,operator_user_id,notes,occurred_at,created_at)
        SELECT lower(hex(randomblob(16))),p.organization_id,p.id,'dispatch',p.location_id,NULL,?,'境外目的仓客户自提复核后出库',?,?
        FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
        WHERE p.organization_id=? AND p.warehouse_id=? AND s.order_id=? AND p.label_kind='oul' AND p.lifecycle_status='overseas_received' AND p.status='in_stock'`).bind(user.userId,now,now,user.organizationId,warehouse.id,orderId),
      env.DB.prepare(`UPDATE warehouse_packages SET status='dispatched',lifecycle_status='signed',signed_at=?,updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='in_stock' AND label_kind='oul' AND lifecycle_status='overseas_received' AND shipment_id IN (SELECT id FROM shipments WHERE organization_id=? AND order_id=?)`).bind(now,now,user.organizationId,warehouse.id,user.organizationId,orderId),
    ]);
    await advanceOverseasOrder({organizationId:user.organizationId,orderId,actorUserId:user.userId,action:"pickup",occurredAt:now,pickupContact:submission.pickupContact ?? undefined,pickupProofReference:submission.pickupProofReference ?? undefined,notes:`${warehouse.name} 已核对整票货物并完成客户自提出库`});
    await writeAudit({request,action:"warehouse.overseas.pickup",resourceType:"transport_order",resourceId:orderId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderNumber:pickup.order_number,confirmedPackages:packages.length,barcodes:expectedCodes}});
    const params=new URLSearchParams({
      warehouseId:warehouse.id,
      pickupResult:`${pickup.order_number} 已复核并完成自提签收，订单进入费用结算`,
      pickupCompleted:"1",
      pickupOrderNumber:pickup.order_number,
      pickupPackageCount:String(packages.length),
    });
    return redirect(`/warehouse/pickup?${params.toString()}`);
  }
  const barcode = valueOf(form, "barcode").trim();
  if (!barcode) return { formError: "请扫描境外仓现有货物标签" };

  const orderLookup = await env.DB.prepare(
    `SELECT op.order_id,o.order_number
       FROM overseas_warehouse_operations op
       JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.warehouse_id=? AND o.order_number=? AND o.status='in_execution' AND op.status!='cancelled'
      ORDER BY op.created_at DESC LIMIT 1`,
  ).bind(user.organizationId, warehouse.id, barcode).first<{
    order_id: string;
    order_number: string;
  }>();
  if (orderLookup) {
    const workflowAccess = await loadWarehousePhysicalWorkflowAccess(
      env.DB,
      user.organizationId,
      orderLookup.order_id,
      "overseas_warehouse",
      { userId: user.userId, positionCode: user.positionCode },
    );
    if (!workflowAccess.available)
      return { formError: workflowAccess.reason || "当前订单的冻结工作流尚未开放客户自提" };

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
      WHERE p.organization_id=? AND p.warehouse_id=? AND p.barcode=? AND p.label_kind='oul' AND p.lifecycle_status='overseas_received' AND p.status='in_stock' AND op.warehouse_id=? AND o.status='in_execution' AND op.status!='cancelled'
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
  const workflowAccess = await loadWarehousePhysicalWorkflowAccess(
    env.DB,
    user.organizationId,
    pkg.order_id,
    "overseas_warehouse",
    { userId: user.userId, positionCode: user.positionCode },
  );
  if (!workflowAccess.available)
    return { formError: workflowAccess.reason || "当前订单的冻结工作流尚未开放客户自提" };

  if (pkg.operation_status === "picked_up")
    return { formError: `${pkg.order_number} 已完成客户自提出库，请勿重复扫描` };
  if (!["notified", "appointment"].includes(pkg.operation_status))
    return { formError: `${pkg.order_number} 尚未完成到仓通知，当前不能办理客户自提出库` };
  if (pkg.status === "dispatched")
    return { formError: `${barcode} 已经出库，请勿重复扫描` };
  if (pkg.status === "exception")
    return { formError: `${barcode} 处于异常状态，请先完成异常处理` };

  const params = new URLSearchParams({
    warehouseId: warehouse.id,
    orderId:pkg.order_id,
    pickupResult: `${pkg.order_number} 已调出；请在当前页面一次扫齐全部 OUL 后确认自提`,
  });
  return redirect(`/warehouse/pickup?${params.toString()}`);
}

function parsePickupCodes(raw:string){
  if(!raw)return[];
  try{const value=JSON.parse(raw);return Array.isArray(value)?[...new Set(value.map(item=>String(item).trim().toUpperCase()).filter(Boolean))]:[]}catch{return[]}
}

export default function WarehousePickup({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const pickupCompletion = loaderData.pickupCompletion;
  const canOperate = canOperateWarehouseUi(
    loaderData.user,
    loaderData.warehouseAccessLevel,
  );
  const [scanInput,setScanInput]=useState("");
  const [scannedCodes,setScannedCodes]=useState<string[]>([]);
  const [scanMessage,setScanMessage]=useState("");
  useEffect(()=>{setScanInput("");setScannedCodes([]);setScanMessage("")},[loaderData.activeOrder?.order_id]);
  const readyToConfirm = Boolean(
    loaderData.activeOrder &&
    loaderData.packages.length > 0 &&
    canOperate &&
    scannedCodes.length===loaderData.packages.length,
  );

  useEffect(() => {
    if (!pickupCompletion || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("pickupCompleted");
    url.searchParams.delete("pickupOrderNumber");
    url.searchParams.delete("pickupPackageCount");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [pickupCompletion]);

  return <>
    <header className="page-header overseas-pickup-header">
      <div>
        <p className="eyebrow">CUSTOMER PICKUP &amp; SIGN-OFF</p>
        <h1>客户扫码自提签收</h1>
        <p>客户到仓后逐件扫描货物条码；全部扫描完成后核对货物并确认收货，一次完成自提出库与签收。</p>
      </div>
    </header>
    {loaderData.workflowGateReason && <p className="alert warning">{loaderData.workflowGateReason}</p>}
    <ActionToast message={actionData?.formError || (!readyToConfirm ? loaderData.result : null)} tone={actionData?.formError ? "error" : "success"} data={actionData}/>
    {pickupCompletion && <Modal
      title="出库成功"
      openSignal={`${pickupCompletion.orderNumber}:${pickupCompletion.packageCount}`}
      dialogClassName="pickup-success-dialog"
      initialFocusSelector="[data-pickup-success-close]"
    >
      {({ close }) => <div className="pickup-success-content" role="status" aria-live="polite">
        <span className="pickup-success-icon" aria-hidden="true">✓</span>
        <div className="pickup-success-message">
          <strong>{pickupCompletion.orderNumber} 已完成自提出库</strong>
          <p>本次已核销并出库 {pickupCompletion.packageCount} 个货物标签，签收结果已同步管理端。</p>
          <small>订单已自动进入对账结算，无需重复扫描。</small>
        </div>
        <button type="button" className="primary warehouse-primary" data-pickup-success-close onClick={close}>知道了</button>
      </div>}
    </Modal>}
    {canOperate&&!loaderData.activeOrder ? <section className="panel overseas-pickup-scan-panel">
      <Form method="post" className="scan-inline overseas-pickup-scan-form">
        <input type="hidden" name="intent" value="scan"/>
        <label className="field">
          <span>扫描境外仓货物条码</span>
          <input name="barcode" placeholder="扫描货物条码后回车" autoComplete="off" autoFocus required />
        </label>
        <button className="primary warehouse-primary" disabled={busy}>{busy ? "正在核对" : "确认扫描"}</button>
      </Form>
      <small>先扫描订单号或任一 OUL 调出订单；调出后全部扫码只保存在当前页面，扫齐并确认时才一次写入。</small>
    </section>
    : !canOperate ? <div className="alert info">当前账号为仓库只读视角，可查看自提队列和历史出库记录；扫码、复核与确认收货仅向有操作权限的冻结任务负责人开放。</div> : null}

    {loaderData.activeOrder && <section className="panel overseas-pickup-progress-panel">
      <div className="panel-header"><div><h2>{loaderData.activeOrder.order_number}</h2><p>{loaderData.activeOrder.customer_name} · {loaderData.activeOrder.batch_number}</p><span className={`pickup-status-summary ${loaderData.activeOrder.appointment_at ? "appointed" : ""}`}><b>预约状态</b>{formatPickupAppointment(loaderData.activeOrder.appointment_at, loaderData.activeOrder.appointment_period)}</span></div><strong>{scannedCodes.length}/{loaderData.packages.length} 已扫描</strong></div>
      {canOperate&&<div className="atomic-pickup-scan"><label className="field"><span>逐一扫描本订单 OUL</span><input value={scanInput} onChange={event=>setScanInput(event.target.value)} onKeyDown={event=>{if(event.key!=="Enter")return;event.preventDefault();const code=scanInput.trim().toUpperCase();if(!code)return;if(!loaderData.packages.some(item=>item.barcode.toUpperCase()===code)){setScanMessage("该 OUL 不属于当前订单");return}if(scannedCodes.includes(code)){setScanMessage("该 OUL 已扫描，本次未重复计数");setScanInput("");return}setScannedCodes(current=>[...current,code]);setScanInput("");setScanMessage("已加入本次临时清单");}} autoFocus placeholder="扫描 OUL 后回车"/></label><span>{scanMessage||"刷新或离开页面会清空临时扫码记录"}</span></div>}
      <div className="table-wrap"><table><thead><tr><th>货物标签</th><th>包装号</th><th>件数</th><th>重量 / 体积</th><th>状态</th></tr></thead><tbody>
        {loaderData.packages.map((item) => {const scanned=scannedCodes.includes(item.barcode.toUpperCase());return <tr key={item.id} className={scanned?"is-scanned":""}><td><strong>{item.barcode}</strong></td><td>{item.package_number}</td><td>{item.pieces}</td><td>{item.weight_kg ?? "—"} KG · {item.volume_cbm ?? "—"} CBM</td><td><span className={`status-pill ${scanned?"success":"warning"}`}>{scanned?"本次已扫":"待扫描"}</span></td></tr>})}
      </tbody></table></div>
      <Form method="post" className="overseas-pickup-confirm-form atomic-pickup-confirm"><input type="hidden" name="intent" value="confirm_pickup"/><input type="hidden" name="orderId" value={loaderData.activeOrder.order_id}/><input type="hidden" name="scannedOulCodes" value={JSON.stringify(scannedCodes)}/><div className="overseas-pickup-confirm-fields">{loaderData.pickupWorkflowPolicy.contact.visible&&<label className="field"><span>{loaderData.pickupWorkflowPolicy.contact.label}{loaderData.pickupWorkflowPolicy.contact.required&&<b className="required-mark"> *</b>}</span><input name="pickupContact" defaultValue={loaderData.activeOrder.suggested_pickup_contact||""} required={loaderData.pickupWorkflowPolicy.contact.required} maxLength={120}/></label>}{loaderData.pickupWorkflowPolicy.proof.visible&&<label className="field"><span>{loaderData.pickupWorkflowPolicy.proof.label}{loaderData.pickupWorkflowPolicy.proof.required&&<b className="required-mark"> *</b>}</span><input name="pickupProofReference" required={loaderData.pickupWorkflowPolicy.proof.required} maxLength={240} placeholder="填写凭证编号或签收凭证引用"/></label>}</div><button className="primary warehouse-primary" disabled={!readyToConfirm||busy}>{busy?"正在原子签收…":readyToConfirm?"全部扫齐，确认自提签收":`还需扫描 ${Math.max(0,loaderData.packages.length-scannedCodes.length)} 个 OUL`}</button></Form>
    </section>}

    <section className="panel overseas-pickup-queue-panel">
      <div className="panel-header"><div><h2>境外仓自提队列</h2><p>统一显示已入库待自提和已自提出库的订单。</p></div><span className="status-pill">{loaderData.pagination.total} 票</span></div>
      <Form method="get" action="." className="warehouse-queue-filter">
        <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>
        <input name="q" defaultValue={loaderData.filters.q} placeholder="订单号、配载单或客户"/>
        <select name="pickupState" defaultValue={loaderData.filters.pickupState}>
          <option value="all">全部自提状态</option>
          <option value="waiting">已到仓待自提</option>
          <option value="picked_up">已自提出库</option>
        </select>
        <button className="secondary">筛选</button>
        <Link className="text-button" to={`?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`}>重置</Link>
      </Form>
      <div className="table-wrap"><table><thead><tr><th>货物状态</th><th>订单 / 配载单</th><th>客户</th><th>通知时间</th><th>客户预约</th><th>标签进度</th><th>自提出库时间</th></tr></thead><tbody>
        {loaderData.orders.map((item) => <tr key={item.order_id}><td><span className={`status-pill ${item.operation_status === "picked_up" ? "" : "off"}`}>{item.operation_status === "picked_up" ? "已自提出库" : "已入库待自提"}</span></td><td><strong>{item.order_number}</strong><small>{item.batch_number}</small></td><td>{item.customer_name}</td><td>{item.notified_at ? new Date(item.notified_at).toLocaleString("zh-CN") : "客户已通知"}</td><td><span className={`pickup-status-summary compact ${item.appointment_at ? "appointed" : ""}`}>{formatPickupAppointment(item.appointment_at, item.appointment_period)}</span></td><td>{item.dispatched_count}/{item.package_count} 已出库</td><td>{item.pickup_at ? new Date(item.pickup_at).toLocaleString("zh-CN") : "—"}</td></tr>)}
        {!loaderData.orders.length && <tr><td colSpan={7} className="empty-state">当前仓库暂无待自提订单。</td></tr>}
      </tbody></table></div>
      <QueryPagination {...loaderData.pagination}/>
    </section>
  </>;
}

export function meta() {
  return [{ title: "客户扫码自提签收 | International TMS" }];
}
