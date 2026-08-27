import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.orders";
import { requireSessionUser } from "../lib/auth.server";

type OrderRow = {
  id: string;
  order_number: string;
  order_date: string | null;
  customer_name: string;
  quote_number: string | null;
  business_type: "ftl" | "ltl";
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  origin_state: string | null;
  origin_city: string;
  destination_state: string | null;
  destination_city: string;
  overseas_warehouse_name: string | null;
  status: string;
  current_step_name: string | null;
  assignee_name: string | null;
  exception_status: string | null;
  completion_status: string | null;
  quote_withdrawn: number;
  created_at: string;
};

type FilterOption = { value: string; label: string };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") || "").trim();
  const type = url.searchParams.get("type") || "";
  const status = url.searchParams.get("status") || "";
  const step = url.searchParams.get("step") || "";
  const exception = url.searchParams.get("exception") || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = 30;
  const where = ["o.organization_id=?"];
  const values: unknown[] = [current.organizationId];
  if (keyword) {
    where.push("(o.order_number LIKE ? OR c.name LIKE ? OR o.cargo_description LIKE ? OR q.quote_number LIKE ?)");
    const pattern = `%${keyword}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (["ftl", "ltl"].includes(type)) {
    where.push("o.business_type=?");
    values.push(type);
  }
  if (status) {
    where.push("o.status=?");
    values.push(status);
  }
  if (step) {
    where.push("COALESCE(o.current_step_name,'')=?");
    values.push(step);
  }
  if (exception === "yes") where.push("COALESCE(o.exception_status,'none')!='none'");
  if (exception === "no") where.push("COALESCE(o.exception_status,'none')='none'");
  const clause = where.join(" AND ");
  const [rows, countRow, stepRows] = await Promise.all([
    env.DB.prepare(
      `SELECT o.id,o.order_number,o.order_date,c.name customer_name,q.quote_number,o.business_type,
        o.cargo_description,o.pieces,o.gross_weight_kg,o.volume_cbm,o.origin_state,o.origin_city,
        o.destination_state,o.destination_city,ow.name overseas_warehouse_name,o.status,
        o.current_step_name,u.display_name assignee_name,o.exception_status,o.completion_status,
        COALESCE(o.quote_withdrawn,0) quote_withdrawn,o.created_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
       LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
       LEFT JOIN users u ON u.id=o.current_assignee_user_id
       WHERE ${clause}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...values, pageSize, (page - 1) * pageSize).all<OrderRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) count FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
       WHERE ${clause}`,
    ).bind(...values).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT DISTINCT current_step_name value,current_step_name label
       FROM transport_orders WHERE organization_id=? AND current_step_name IS NOT NULL
       ORDER BY current_step_name`,
    ).bind(current.organizationId).all<FilterOption>(),
  ]);
  const total = countRow?.count || 0;
  return {
    orders: rows.results,
    filters: { keyword, type, status, step, exception },
    steps: stepRows.results,
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export default function Orders({ loaderData }: Route.ComponentProps) {
  const active = loaderData.orders.filter((order) => !["completed", "cancelled"].includes(order.status)).length;
  const completed = loaderData.orders.filter((order) => order.status === "completed").length;
  const exceptions = loaderData.orders.filter((order) => order.exception_status && order.exception_status !== "none").length;
  return (
    <div className="page prototype-page order-list-page">
      <div className="breadcrumb">汽运业务 / 运输订单</div>
      <header className="page-head">
        <div><h1>运输订单</h1><p>订单由客户接受报价后自动生成；在一张表内筛选、查看并进入当前业务节点。</p></div>
        <Link className="btn primary" to="/admin/quotations">前往询价与报价</Link>
      </header>
      <section className="kpis compact-kpis" aria-label="订单概览">
        <div><span>当前结果</span><b>{loaderData.total}</b><small>符合筛选条件</small></div>
        <div><span>业务处理中</span><b>{active}</b><small>当前页</small></div>
        <div><span>已完成</span><b>{completed}</b><small>当前页</small></div>
        <div><span>异常订单</span><b>{exceptions}</b><small>当前页</small></div>
      </section>
      <Form method="get" action="." className="filters order-table-filters">
        <label className="field wide"><span>快速查找</span><input className="control" name="keyword" defaultValue={loaderData.filters.keyword} placeholder="订单号、报价号、客户或货物"/></label>
        <FilterSelect name="type" label="订单类型" value={loaderData.filters.type} options={[{ value: "ftl", label: "整车" }, { value: "ltl", label: "拼车" }]}/>
        <FilterSelect name="status" label="订单状态" value={loaderData.filters.status} options={statusOptions}/>
        <FilterSelect name="step" label="当前节点" value={loaderData.filters.step} options={loaderData.steps}/>
        <FilterSelect name="exception" label="异常" value={loaderData.filters.exception} options={[{ value: "no", label: "无异常" }, { value: "yes", label: "有异常" }]}/>
        <button className="btn primary">筛选</button>
        <Link className="btn" to="/admin/orders">重置</Link>
      </Form>
      <section className="table-panel order-table-panel">
        <div className="table-panel-head"><div><b>订单主表</b><span>每行是一张订单，橙色动作直接进入该订单当前节点。</span></div><span>{loaderData.total} 单</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>订单 / 报价</th><th>客户</th><th>类型</th><th>货物与实物数据</th><th>线路与目的仓</th><th>当前节点</th><th>负责人</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {loaderData.orders.map((order) => (
                <tr key={order.id} className={order.status !== "completed" && order.exception_status && order.exception_status !== "none" ? "row-alert" : ""}>
                  <td><Link className="order-id" to={`/admin/orders/${order.id}`}>{order.order_number}</Link><small className="subline">{order.quote_number || "历史订单无关联报价"}</small></td>
                  <td><b>{order.customer_name}</b><small className="subline">{order.order_date || order.created_at.slice(0, 10)}</small></td>
                  <td><span className={`pill ${order.business_type === "ltl" ? "ltl" : ""}`}>{order.business_type === "ltl" ? "拼车" : "整车"}</span></td>
                  <td><b>{order.cargo_description || "未填写"}</b><small className="subline">{order.pieces} 件 · {order.gross_weight_kg} KG · {order.volume_cbm} CBM</small></td>
                  <td><b>{order.origin_state || ""}{order.origin_city} → {order.destination_state || ""}{order.destination_city}</b><small className="subline">{order.overseas_warehouse_name || "目的仓未填写"}</small></td>
                  <td><b>{order.quote_withdrawn ? "报价接受已撤回" : order.current_step_name || "待同步"}</b><small className="subline">{order.completion_status === "completed" ? "业务与结算已完成" : "按工作流推进"}</small></td>
                  <td>{order.assignee_name || "待分配"}</td>
                  <td><span className={`status ${statusTone(order.status, order.exception_status)}`}>{statusLabel(order.status)}</span></td>
                  <td><Link className="btn primary small" to={`/admin/orders/${order.id}`}>{order.status === "completed" ? "查看订单" : "办理当前节点"}</Link></td>
                </tr>
              ))}
              {!loaderData.orders.length && <tr><td className="empty" colSpan={9}>当前筛选条件下没有订单</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination page={loaderData.page} pages={loaderData.pages} filters={loaderData.filters}/>
      </section>
    </div>
  );
}

function FilterSelect({ name, label, value, options }: { name: string; label: string; value: string; options: FilterOption[] }) {
  return <label className="field"><span>{label}</span><select className="control filled" name={name} defaultValue={value}><option value="">全部</option>{options.map((option) => <option key={`${name}-${option.value}`} value={option.value}>{option.label}</option>)}</select></label>;
}

function Pagination({ page, pages, filters }: { page: number; pages: number; filters: Record<string, string> }) {
  if (pages <= 1) return null;
  const href = (target: number) => {
    const params = new URLSearchParams(filters);
    params.set("page", String(target));
    return `?${params}`;
  };
  return <div className="pagination"><Link className={`btn ${page <= 1 ? "disabled" : ""}`} to={href(Math.max(1, page - 1))}>上一页</Link><span>第 {page} / {pages} 页</span><Link className={`btn ${page >= pages ? "disabled" : ""}`} to={href(Math.min(pages, page + 1))}>下一页</Link></div>;
}

const statusOptions = [
  { value: "draft", label: "草稿" },
  { value: "submitted", label: "待审核" },
  { value: "confirmed", label: "已审核，待派单" },
  { value: "in_execution", label: "执行中" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

function statusLabel(status: string) {
  return statusOptions.find((option) => option.value === status)?.label || status;
}

function statusTone(status: string, exceptionStatus: string | null) {
  if (status === "completed") return "green";
  if (exceptionStatus && exceptionStatus !== "none") return "red";
  if (["cancelled"].includes(status)) return "red";
  if (["draft", "submitted"].includes(status)) return "orange";
  return "blue";
}

export function meta() { return [{ title: "运输订单 | 新翎航 TMS" }]; }
