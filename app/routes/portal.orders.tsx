import { env } from "cloudflare:workers";
import { useNavigation } from "react-router";
import type { Route } from "./+types/portal.orders";
import { OrderMarkLabelModal } from "../components/OrderMarkLabelModal";
import { OrderRouteFilterFields } from "../components/OrderRouteFilterFields";
import { PortalPickupAppointment } from "../components/PortalPickupAppointment";
import { PortalForm as Form, PortalLink as Link } from "../components/PortalNavigation";
import { QueryPagination } from "../components/QueryPagination";
import { ActionToast } from "../components/ActionToast";
import {
  PortalQuoteReviewModal,
  quotationStatusLabel,
  quotationStatusTone,
  type PortalQuote,
  type PortalQuoteCharge,
} from "../components/PortalQuoteReview";
import { loadActiveOrderMarksByOrder, type OrderMarkLabel } from "../lib/order-mark-label.server";
import { paginateList, readListPage } from "../lib/list-pagination";
import { customerFacingOrderStatusLabel } from "../lib/overseas-warehouse";
import { orderRouteFilterCount, readOrderRouteFilters } from "../lib/order-route-filters";
import { handlePortalQuotationAction } from "../lib/portal-quotation-action.server";
import { requirePortalCustomer } from "../lib/portal.server";
import {
  listQuotationWorkflowFields,
  listQuotationWorkflowFieldValues,
  listQuotationWorkflowInstanceFields,
} from "../lib/quotation-workflow-fields.server";

type PortalOrder = OrderMarkLabel & {
  quote_number: string | null;
  business_type: "ftl" | "ltl";
  current_step_name: string | null;
  exception_status: string | null;
  quote_withdrawn: number;
  created_at: string;
  overseas_operation_status: string | null;
  pickup_appointment_at: string | null;
  pickup_appointment_period: string | null;
  origin_address: string | null;
  exit_port: string | null;
  exit_port_name: string | null;
  destination_address: string | null;
};

const quoteStatusMap = {
  quote_pending: "pending",
  quote_withdrawn: "withdrawn",
  quote_void: "void",
} as const;

export async function loader({ request }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") || "").trim();
  const status = url.searchParams.get("status") || "";
  const quotationId = url.searchParams.get("quote")?.trim() || "";
  const requestedPage = readListPage(url.searchParams);
  const routeFilters = readOrderRouteFilters(url.searchParams);
  const quoteLifecycle = quoteStatusMap[status as keyof typeof quoteStatusMap];

  const orderWhere = ["o.organization_id=?", "o.customer_id=?"];
  const orderValues: unknown[] = [user.organizationId, customer.id];
  const quoteWhere = ["q.organization_id=?", "q.customer_id=?"];
  const quoteValues: unknown[] = [user.organizationId, customer.id];

  if (keyword) {
    const pattern = `%${keyword}%`;
    orderWhere.push("(o.order_number LIKE ? OR q.quote_number LIKE ? OR o.cargo_description LIKE ?)");
    orderValues.push(pattern, pattern, pattern);
    quoteWhere.push("(q.quote_number LIKE ? OR q.cargo_description LIKE ?)");
    quoteValues.push(pattern, pattern);
  }

  if (quoteLifecycle) {
    orderWhere.push("1=0");
    quoteWhere.push("q.lifecycle_status=?");
    quoteValues.push(quoteLifecycle);
  } else if (status) {
    orderWhere.push("o.status=?");
    orderValues.push(status);
    quoteWhere.push("1=0");
  } else {
    orderWhere.push("(q.lifecycle_status IS NULL OR q.lifecycle_status='accepted')");
    quoteWhere.push("(q.lifecycle_status IN ('pending','withdrawn','void') OR (q.lifecycle_status='accepted' AND o.id IS NULL))");
  }

  if (routeFilters.origin) {
    const pattern = `%${routeFilters.origin}%`;
    orderWhere.push("(o.origin_country LIKE ? OR o.origin_state LIKE ? OR o.origin_city LIKE ? OR o.origin_address LIKE ?)");
    orderValues.push(pattern, pattern, pattern, pattern);
    quoteWhere.push("(q.origin_country LIKE ? OR q.origin_state LIKE ? OR q.origin_city LIKE ? OR q.pickup_address LIKE ?)");
    quoteValues.push(pattern, pattern, pattern, pattern);
  }
  if (routeFilters.exitPort) {
    const pattern = `%${routeFilters.exitPort}%`;
    orderWhere.push("(o.exit_port LIKE ? OR EXISTS (SELECT 1 FROM reference_data route_port WHERE route_port.organization_id=o.organization_id AND route_port.category='border_port' AND route_port.code=o.exit_port AND route_port.name LIKE ?))");
    orderValues.push(pattern, pattern);
    quoteWhere.push("1=0");
  }
  if (routeFilters.destination) {
    const pattern = `%${routeFilters.destination}%`;
    orderWhere.push("(o.destination_country LIKE ? OR o.destination_state LIKE ? OR o.destination_city LIKE ? OR o.destination_address LIKE ? OR w.name LIKE ?)");
    orderValues.push(pattern, pattern, pattern, pattern, pattern);
    quoteWhere.push("(q.destination_country LIKE ? OR q.destination_state LIKE ? OR q.destination_city LIKE ? OR q.destination_warehouse_note LIKE ? OR qw.name LIKE ?)");
    quoteValues.push(pattern, pattern, pattern, pattern, pattern);
  }

  const [orderRows, quoteRows, chargeRows] = await Promise.all([
    env.DB.prepare(
      `SELECT o.id,o.order_number,c.name customer_name,q.quote_number,o.business_type,o.cargo_description,o.pieces,
        o.declared_quantity_unit,o.planned_inbound_package_count,o.planned_inbound_package_type,o.inbound_package_locked_at,
        o.gross_weight_kg,o.volume_cbm,o.origin_country,o.origin_state,o.origin_city,o.origin_address,
        o.exit_port,bp.name exit_port_name,o.destination_country,o.destination_state,o.destination_city,o.destination_address,
        w.name overseas_warehouse_name,o.status,o.current_step_name,
        o.exception_status,o.created_at,
        op.status overseas_operation_status,op.appointment_at pickup_appointment_at,
        op.appointment_period pickup_appointment_period,
        CASE
          WHEN q.accepted_at IS NOT NULL THEN q.accepted_at
          WHEN o.quotation_id IS NULL AND o.status IN ('confirmed','in_execution','completed') THEN o.created_at
          ELSE ''
        END label_generated_at,o.quote_withdrawn
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
       LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
       LEFT JOIN reference_data bp ON bp.organization_id=o.organization_id AND bp.category='border_port' AND bp.code=o.exit_port
       LEFT JOIN overseas_warehouse_operations op ON op.id=(
         SELECT latest.id FROM overseas_warehouse_operations latest
         WHERE latest.organization_id=o.organization_id AND latest.order_id=o.id
           AND latest.status!='cancelled'
         ORDER BY latest.created_at DESC LIMIT 1
       )
       WHERE ${orderWhere.join(" AND ")}
       ORDER BY CASE WHEN q.id=? THEN 0 ELSE 1 END,o.created_at DESC`,
    ).bind(...orderValues, quotationId).all<PortalOrder>(),
    env.DB.prepare(
      `SELECT q.id,q.quote_number,c.name customer_name,q.customer_contact_name,q.customer_contact_phone,
        u.display_name salesperson_name,q.workflow_definition_id,wd.name workflow_name,wd.version_number workflow_version_number,
        q.origin_country,q.origin_state,q.origin_city,q.pickup_address,
        q.destination_country,q.destination_state,q.destination_city,qw.name destination_warehouse_name,
        q.destination_warehouse_note,q.customs_clearance_mode,q.road_load_type,q.cargo_description,
        q.pieces,q.declared_quantity_unit,q.planned_package_count,q.planned_package_type,
        q.gross_weight_kg,q.volume_cbm,q.estimated_length_cm,q.estimated_width_cm,
        q.estimated_height_cm,q.total_amount,q.valid_until,q.notes,q.lifecycle_status,
        o.id order_id,o.order_number,o.status order_status,o.current_step_code,q.created_at
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id AND c.organization_id=q.organization_id
       LEFT JOIN users u ON u.id=q.salesperson_user_id
       LEFT JOIN workflow_definitions wd ON wd.id=q.workflow_definition_id AND wd.organization_id=q.organization_id
       LEFT JOIN warehouses qw ON qw.id=q.destination_warehouse_id AND qw.organization_id=q.organization_id
       LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
       WHERE ${quoteWhere.join(" AND ")}
       ORDER BY CASE WHEN q.id=? THEN 0 ELSE 1 END,q.created_at DESC`,
    ).bind(...quoteValues, quotationId).all<PortalQuote>(),
    env.DB.prepare(
      `SELECT qc.quotation_id,qc.description,qc.quantity,qc.unit_price,qc.amount,qc.sort_order
       FROM quotation_charges qc
       JOIN quotations q ON q.id=qc.quotation_id
       WHERE q.organization_id=? AND q.customer_id=?
       ORDER BY qc.quotation_id,qc.sort_order,qc.id`,
    ).bind(user.organizationId, customer.id).all<PortalQuoteCharge>(),
  ]);

  const combinedRows = [
    ...quoteRows.results.map((value) => ({ kind: "quote" as const, value })),
    ...orderRows.results.map((value) => ({ kind: "order" as const, value })),
  ];
  const pagination = paginateList(combinedRows, requestedPage);
  const visibleQuotes = pagination.items.flatMap((item) => item.kind === "quote" ? [item.value] : []);
  const visibleOrders = pagination.items.flatMap((item) => item.kind === "order" ? [item.value] : []);

  const charges = new Map<string, PortalQuoteCharge[]>();
  for (const charge of chargeRows.results) {
    charges.set(charge.quotation_id, [...(charges.get(charge.quotation_id) || []), charge]);
  }
  const quoteIds = visibleQuotes.map((quote) => quote.id);
  const [workflowFields, quotationWorkflowFields, workflowValues] = await Promise.all([
    listQuotationWorkflowFields(user.organizationId),
    listQuotationWorkflowInstanceFields(user.organizationId, quoteIds),
    listQuotationWorkflowFieldValues(user.organizationId, quoteIds),
  ]);

  const marksByOrder = await loadActiveOrderMarksByOrder(
    user.organizationId,
    visibleOrders.map((order) => order.id),
  );
  const orders = visibleOrders.map((order) => ({
    ...order,
    marks: marksByOrder.get(order.id) ?? [],
  }));

  return {
    orders,
    quotes: visibleQuotes,
    pagination: {
      page: pagination.page,
      pageCount: pagination.pageCount,
      pageSize: pagination.pageSize,
      total: pagination.total,
    },
    charges: Object.fromEntries(charges),
    quotationId,
    workflowFields,
    quotationWorkflowFields,
    workflowValues,
    filters: { keyword, status, ...routeFilters },
    appointmentResult: url.searchParams.get("appointmentResult") || "",
    appointmentError: url.searchParams.get("appointmentError") || "",
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  return handlePortalQuotationAction({ request, user, customer });
}

export default function PortalOrders({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const advancedFilterCount = orderRouteFilterCount(loaderData.filters);
  const total = loaderData.pagination.total;
  return (
    <div className="page prototype-page">
      <div className="breadcrumb">客户门户 / 我的订单</div>
      <header className="page-head"><div><h1>我的订单</h1><p>待确认报价与运输订单统一管理；请先查看完整报价信息，再在弹窗内确认。</p></div></header>
      <ActionToast data={actionData}/>
      <ActionToast message={loaderData.appointmentError || loaderData.appointmentResult} tone={loaderData.appointmentError ? "error" : "success"}/>
      {loaderData.quotationId && loaderData.quotes.some((quote) => quote.id === loaderData.quotationId) && !actionData?.success && (
        <div className="alert portal-quote-focus-notice" role="status"><span>已定位通知中的待确认报价，请点击“查看信息”核对后确认。</span><Link className="btn small" to="/portal/orders">取消定位</Link></div>
      )}
      <Form method="get" action="." className="filters order-table-filters">
        <label className="field wide"><span>快速查找</span><input className="control" name="keyword" data-keyboard-search defaultValue={loaderData.filters.keyword} placeholder="订单号或货物"/></label>
        <label className="field"><span>业务状态</span><select className="control filled" name="status" defaultValue={loaderData.filters.status}><option value="">全部</option>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button className="btn primary">筛选</button><Link className="btn" to="/portal/orders">重置</Link>
        <details className="order-route-advanced-filter" open={advancedFilterCount > 0}>
          <summary><span>更多筛选条件</span><small>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "出发地、出境口岸、目的地"}</small></summary>
          <div className="order-route-filter-grid"><OrderRouteFilterFields filters={loaderData.filters}/></div>
        </details>
      </Form>
      <section className="table-panel">
        <div className="table-panel-head"><div><b>我的订单</b><span>待确认报价完成确认后自动生成订单号，并继续在本列表展示。</span></div><span>{total} 条</span></div>
        <div className="table-wrap"><table><thead><tr><th>订单号</th><th>类型</th><th>货物</th><th>运输线路</th><th>当前节点</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {loaderData.quotes.map((quote) => {
            const snapshotFields = loaderData.quotationWorkflowFields.filter((field) => field.quotation_id === quote.id);
            const fields = snapshotFields.length ? snapshotFields : loaderData.workflowFields.filter((field) => field.workflow_id === quote.workflow_definition_id);
            return <tr key={`quote-${quote.id}`} id={`quote-${quote.id}`} className={`portal-quote-pending-row${loaderData.quotationId === quote.id ? " portal-quote-focus-row" : ""}`}>
              <td><b className="pending-order-label">待确认报价</b><small className="subline">确认后生成订单号</small></td>
              <td><span className={`pill ${quote.road_load_type === "ltl" ? "ltl" : ""}`}>{quote.road_load_type === "ltl" ? "拼车" : "整车"}</span></td>
              <td><b>{quote.cargo_description}</b><small className="subline">{quote.pieces} 件 · {quote.gross_weight_kg} KG · {quote.volume_cbm} CBM</small></td>
              <td><b>{quote.origin_state || ""}{quote.origin_city} → {quote.destination_state || ""}{quote.destination_city}</b><small className="subline">目的仓：{quote.destination_warehouse_name || "待补充"}</small></td>
              <td>客户确认报价</td>
              <td><span className={`status ${quotationStatusTone(quote.lifecycle_status)}`}>{quotationStatusLabel(quote.lifecycle_status)}</span>{quote.valid_until && <small className="subline">有效期至 {quote.valid_until}</small>}</td>
              <td><PortalQuoteReviewModal quote={quote} charges={loaderData.charges[quote.id] || []} fields={fields} values={loaderData.workflowValues.filter((value) => value.quotation_id === quote.id)} busy={busy} closeSignal={actionData?.success}/></td>
            </tr>;
          })}
          {loaderData.orders.map((order) => <tr key={order.id} className={order.status !== "completed" && order.exception_status && order.exception_status !== "normal" ? "row-alert" : ""}>
            <td><b className="order-id order-number-only" title={order.order_number}>{order.order_number}</b></td>
            <td><span className={`pill ${order.business_type === "ltl" ? "ltl" : ""}`}>{order.business_type === "ltl" ? "拼车" : "整车"}</span></td>
            <td><b>{order.cargo_description}</b><small className="subline">{order.pieces} 件 · {order.gross_weight_kg} KG · {order.volume_cbm} CBM</small></td>
            <td><b>{order.origin_state || ""}{order.origin_city} → {order.destination_state || ""}{order.destination_city}</b><small className="subline">{order.exit_port_name || order.exit_port || "口岸待定"} · {order.overseas_warehouse_name || "目的仓待补"}</small></td>
            <td>{order.current_step_name || "待同步"}</td>
            <td><span className={`status ${statusTone(order.status, order.exception_status)}`}>{customerFacingOrderStatusLabel(order.status, order.overseas_operation_status)}</span></td>
            <td><div className="portal-order-actions"><PortalPickupAppointment order={order} returnTo="/portal/orders"/><Link className="btn small" to={`/portal/tracking?order=${encodeURIComponent(order.order_number)}`}>查看轨迹</Link>{markLabelAvailable(order) && <OrderMarkLabelModal order={order} />}</div></td>
          </tr>)}
          {!total && <tr><td className="empty" colSpan={7}>暂无待确认报价或运输订单。</td></tr>}
        </tbody></table></div>
      </section>
      <QueryPagination {...loaderData.pagination} unit="条"/>
    </div>
  );
}

const statusOptions = [
  { value: "quote_pending", label: "待确认报价" },
  { value: "quote_withdrawn", label: "接受已撤回" },
  { value: "quote_void", label: "已作废报价" },
  { value: "draft", label: "待补充委托资料" },
  { value: "submitted", label: "待审核" },
  { value: "confirmed", label: "已审核，待派单" },
  { value: "in_execution", label: "运输执行中" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

function statusTone(status: string, exceptionStatus: string | null) {
  if (status === "completed") return "green";
  if (exceptionStatus && exceptionStatus !== "normal") return "red";
  if (status === "cancelled") return "red";
  if (["draft", "submitted"].includes(status)) return "orange";
  return "blue";
}

function markLabelAvailable(order: PortalOrder) {
  return Boolean(order.label_generated_at) && order.quote_withdrawn !== 1 && order.status !== "cancelled";
}

export function meta() { return [{ title: "我的订单 | 新翎航客户门户" }]; }
