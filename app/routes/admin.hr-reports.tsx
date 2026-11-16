import { env } from "cloudflare:workers";
import { Form,Link,useLocation,useNavigation,useNavigate,redirect } from "react-router";
import type { Route } from "./+types/admin.hr-reports";
import { requireSessionUser } from "../lib/auth.server";
import { loadHrReport,saveCommission,summarizeHrReport } from "../lib/hr-reports.server";
import { loadBusinessProcessPolicy } from "../lib/business-process-policy.server";
import { policyEnabled } from "../lib/business-process-policy";
import { hrReportPeriod } from "../lib/hr-reports";
import { paginateList,readListPage } from "../lib/list-pagination";
import { QueryPagination } from "../components/QueryPagination";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { Modal } from "../components/Modal";
import { loadHrConsignments } from "../lib/hr-consignments.server";
import { hrCashStates, readHrConsignmentFilters } from "../lib/hr-consignments";
import { statusLabel } from "../lib/order-workflow";
import { sessionSlotFromUrl, withSessionSlot } from "../lib/session-slot";
export async function loader({request}:Route.LoaderArgs) {
  const current=await requireSessionUser(request,"hr.report.view"),url=new URL(request.url),kind=url.searchParams.get("period")==="week"?"week":"month",defaults=hrReportPeriod(new Date(),kind),from=url.searchParams.get("from")||defaults.from,to=url.searchParams.get("to")||defaults.to;
  if (url.searchParams.get("export") === "1") {
    if (!current.permissions.includes("data.export")) throw new Response("没有导出权限", { status: 403 });
    url.searchParams.delete("export");
    throw redirect(`/admin/hr-reports/export${url.search}`);
  }
  const policy=await loadBusinessProcessPolicy(current.organizationId),enabled=policyEnabled(policy,"hr.reports_enabled");
  if (url.searchParams.get("view") !== "paid") {
    let filters;
    try { filters = readHrConsignmentFilters(url.searchParams, defaults); }
    catch (error) { throw new Response(error instanceof Error ? error.message : "人事台账加载失败", { status: 400 }); }
    const { rows, ...ledger } = await loadHrConsignments(env.DB, current, filters);
    return { view: "consignments" as const, current, ...ledger, pagination: paginateList(rows, readListPage(url.searchParams)), total: rows.length, eligible: rows.filter(row => row.commissionEligible).length };
  }
  const rows=await loadHrReport(env.DB,current,from,to);
  const snapshots=current.dataScope==="company"?(await env.DB.prepare("SELECT period_kind,date_from,date_to,created_at FROM hr_report_snapshots WHERE organization_id=? ORDER BY created_at DESC LIMIT 12").bind(current.organizationId).all<{period_kind:string;date_from:string;date_to:string;created_at:string}>()).results:[];
  return {view:"paid" as const,current,enabled,from,to,kind,pagination:paginateList(rows,readListPage(url.searchParams)),total:rows.length,totalProfit:current.permissions.includes("hr.report.amount.view")?rows.reduce((sum,r)=>sum+Number(r.profit),0):null,summary:summarizeHrReport(rows),snapshots};
}
export async function action({request}:Route.ActionArgs) {
  const current=await requireSessionUser(request,"hr.commission.manage"),form=await request.formData(),v=(key:string)=>String(form.get(key)??"");
  try {await saveCommission(env.DB,{current,orderId:v("orderId"),amount:Number(v("amount")),status:v("status"),paidOn:v("paidOn"),notes:v("notes"),revision:Number(v("revision"))});return {success:"提成记录已保存，修改历史保留。",savedAt:crypto.randomUUID()};}
  catch(error){return {formError:error instanceof Error?error.message:"保存失败"};}
}
export default function HrReports({loaderData,actionData}:Route.ComponentProps) {
  const busy=useNavigation().state!=="idle",data=loaderData,navigate=useNavigate(),location=useLocation();
  if (data.view === "consignments") return <HrConsignments data={data}/>;
  return <div className="module-business-stack"><header className="page-header"><div><h1>人事回款与提成报表</h1><p>按实际核销统计已全部回款订单；毛利排除过关税费、赔偿等异常费用。提成由有权限人员填写，金额统一 CNY。</p></div></header>
    <HrReportTabs active="paid"/>
    {actionData?.formError&&<p className="alert danger" role="alert">{actionData.formError}</p>}{actionData?.success&&<p className="alert success" role="status">{actionData.success}</p>}
    {data.current.permissions.includes('order.intake.manage')&&<Link className="secondary" to="/admin/quotations?entryMode=direct">紧急协助录单（仍须操作主管审批）</Link>}
    {!data.enabled&&<p className="alert">人事登记功能已停用，历史报表仍可查看。</p>}
    <Form key={`${data.kind}-${data.from}-${data.to}`} method="get" className="tracking-center-filter"><input type="hidden" name="view" value="paid"/><label>周期<select name="period" defaultValue={data.kind} onChange={e=>navigate(`?view=paid&period=${e.target.value}`)}><option value="week">本周</option><option value="month">本月</option></select></label><label>回款开始日<input type="date" name="from" defaultValue={data.from}/></label><label>回款结束日<input type="date" name="to" defaultValue={data.to}/></label><button className="primary">查询</button>{data.current.permissions.includes("data.export")&&<Link className="secondary" reloadDocument to={withSessionSlot(`/admin/hr-reports/export?view=paid&from=${data.from}&to=${data.to}`,sessionSlotFromUrl(location.pathname+location.search))}>导出 Excel 可打开的 CSV</Link>}</Form>
    <p>已全部回款 {data.total} 票 · 完成 {data.summary.completed} 票 · 发车 {data.summary.departures} 批（拼车批次去重）{data.totalProfit!==null?` · 已确认毛利 ${data.totalProfit.toFixed(2)} CNY · ${data.summary.pendingCost} 票成本待确认，不计正式毛利`:" · 金额按权限隐藏"}</p>
    <details className="panel"><summary>按业务员汇总</summary><div className="table-wrap"><table><thead><tr><th>业务员</th><th>全部回款 / 已完成</th><th>成本待确认</th><th>确认毛利 CNY</th><th>已发提成 CNY</th></tr></thead><tbody>{data.summary.teams.map(team=><tr key={team.id}><td>{team.name}</td><td>{team.orders} / {team.completed}</td><td>{team.pendingCost}</td><td>{data.totalProfit===null?'隐藏':team.profit.toFixed(2)}</td><td>{data.totalProfit===null?'隐藏':team.commissionPaid.toFixed(2)}</td></tr>)}</tbody></table></div></details>
    <div className="table-wrap"><table><thead><tr><th>订单 / 业务员</th><th>回款日</th><th>主车 / 换装车</th><th>收入 / 成本 / 毛利 CNY</th><th>提成 CNY / 发放</th><th>操作</th></tr></thead><tbody>{data.pagination.items.map(row=><tr key={row.id}>
      <td><OrderNumberLink id={row.id} number={row.order_number}/><small>{row.salesperson_name||"待指定"}</small></td><td>{row.paid_on}</td>
      <td>{row.main_plates||"—"}<small>换装：{row.transloading_plates||"—"} · {row.departure_count} 批</small></td>
      <td>{row.revenue===null?"无金额查看权限":`${row.revenue.toFixed(2)} / ${row.cost_pending?'待确认 / 待确认':`${row.cost?.toFixed(2)} / ${row.profit?.toFixed(2)}`}`}</td>
      <td>{row.commission_amount??"隐藏"} · {row.commission_status==="paid"?"已发放":"未发放"}<small>{row.commission_paid_on}</small></td>
      <td>{data.enabled&&data.current.permissions.includes("hr.commission.manage")&&data.current.permissions.includes("hr.report.amount.view")&&<Modal title={`提成登记 · ${row.order_number}`} triggerLabel="登记提成" closeSignal={actionData?.savedAt}>
        <Form method="post" className="form-grid"><input type="hidden" name="orderId" value={row.id}/><input type="hidden" name="revision" value={row.commission_revision}/><label>提成金额 CNY<input name="amount" type="number" min="0" step="0.01" required defaultValue={row.commission_amount??0}/></label><label>发放状态<select name="status" defaultValue={row.commission_status}><option value="pending">未发放</option><option value="paid">已发放</option></select></label><label>实际发放日期<input type="date" name="paidOn" defaultValue={row.commission_paid_on??""}/></label><label>说明<textarea name="notes" maxLength={2000} defaultValue={row.commission_notes??''}/></label><button className="primary" disabled={busy}>保存记录</button></Form>
      </Modal>}</td>
    </tr>)}</tbody></table></div><QueryPagination {...data.pagination} unit="票回款订单"/>
    <details className="panel"><summary>定时生成记录（上周 / 上月）</summary>{data.snapshots.map((s,i)=><p key={i}>{s.period_kind==="week"?"周报":"月报"} · {s.date_from} 至 {s.date_to} · 生成于 {s.created_at}</p>)}</details>
  </div>;
}

function HrReportTabs({active}:{active:"consignments"|"paid"}) {
  return <nav className="peer-page-tabs hr-report-tabs" aria-label="人事报表视图"><Link to="?view=consignments" className={active === "consignments" ? "active" : ""} aria-current={active === "consignments" ? "page" : undefined}>全部委托与报价归属</Link><Link to="?view=paid" className={active === "paid" ? "active" : ""} aria-current={active === "paid" ? "page" : undefined}>已回款提成依据</Link></nav>;
}
function HrConsignments({data}:{data:Extract<Route.ComponentProps["loaderData"],{view:"consignments"}>}) {
  const location = useLocation();
  const filters = data.filters, exportParams = new URLSearchParams({view:"consignments",...filters,export:"1"});
  const amount = (value:number|null|undefined) => value == null ? "待核对" : value.toFixed(2);
  return <div className="module-business-stack hr-consignment-workspace">
    <header className="page-header"><div><h1>人事委托台账</h1><p>未回款订单也能查报价归属。预计、已确认费用与实际收付款核销分开；不自动计算提成比例。</p></div></header>
    <HrReportTabs active="consignments"/>
    <Form method="get" className="tracking-center-filter hr-consignment-filter" key={JSON.stringify(filters)}>
      <input type="hidden" name="view" value="consignments"/>
      <label>接单开始日<input type="date" name="from" defaultValue={filters.from}/></label><label>接单结束日<input type="date" name="to" defaultValue={filters.to}/></label>
      <label>报价商务<select name="commercial" defaultValue={filters.commercial}><option value="">全部</option>{data.commercialOptions.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label>业务员<select name="salesperson" defaultValue={filters.salesperson}><option value="">全部</option>{data.salespersonOptions.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label>装车方式<select name="businessType" defaultValue={filters.businessType}><option value="">全部</option><option value="ltl">拼车</option><option value="ftl">整车</option></select></label>
      <label>业务大类<input name="businessMajor" maxLength={120} defaultValue={filters.businessMajor} placeholder="按录单文字筛选"/></label>
      <label>业务类型<input name="businessKind" maxLength={120} defaultValue={filters.businessKind} placeholder="按录单文字筛选"/></label>
      {(["receipt","payment"] as const).map(key=><label key={key}>{key === "receipt" ? "应收核销" : "应付核销"}<select name={key} defaultValue={filters[key]}><option value="">全部</option>{Object.entries(hrCashStates).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}
      <div className="hr-consignment-filter-actions"><button className="primary">筛选</button><Link className="secondary" to="?view=consignments&from=&to=">重置（全部日期）</Link></div>
    </Form>
    <div className="module-toolbar"><span>筛选结果 {data.total} 票 · 其中 {data.eligible} 票符合现有回款提成登记口径</span>{data.current.permissions.includes("data.export")&&<Link className="secondary" reloadDocument to={withSessionSlot(`/admin/hr-reports/export?${exportParams}`,sessionSlotFromUrl(location.pathname+location.search))}>导出当前筛选 CSV</Link>}</div>
    {!data.current.permissions.includes("hr.report.amount.view")&&<p className="alert">金额按权限隐藏，导出同样不含金额；报价归属和核销状态仍可查询。</p>}
    <div className="table-wrap hr-consignment-table" role="region" aria-label="人事委托台账，可左右滚动" tabIndex={0}><table><thead><tr><th>订单 / 日期</th><th>客户 / 装车方式</th><th>报价商务</th><th>业务员 / 录单人</th><th>预估 / 已确认应收 CNY</th><th>预估 / 已确认应付 CNY</th><th>已确认配载分摊 CNY</th><th>收款 / 付款核销 CNY</th><th>核销状态</th><th>提成依据</th></tr></thead>
      <tbody>{data.pagination.items.map(row=><tr key={row.id}><td><OrderNumberLink id={row.id} number={row.order_number}/><small>{row.order_date}</small></td><td>{row.customer_name}<small>{row.business_type === "ltl" ? "拼车" : row.business_type === "ftl" ? "整车" : row.business_type} · {statusLabel(row.status)}</small><small>{row.businessMajor||"大类未记录"} / {row.businessKind||"类型未记录"}</small></td>
        <td>{row.quote_commercial_name_snapshot || "历史未记录"}</td><td>{row.salesperson_name || "未指定"}<small>录单：{row.creator_name || "历史未记录"}</small></td>
        <td>{row.amounts ? `${amount(row.amounts.estimatedReceivable)} / ${amount(row.amounts.confirmedReceivable)}` : "按权限隐藏"}</td><td>{row.amounts ? `${amount(row.amounts.estimatedPayable)} / ${amount(row.amounts.confirmedPayable)}` : "按权限隐藏"}</td>
        <td>{row.amounts ? amount(row.amounts.confirmedAllocation) : "按权限隐藏"}<small>已含于应付，不另加</small></td><td>{row.amounts ? `${amount(row.amounts.receiptAllocated)} / ${amount(row.amounts.paymentAllocated)}` : "按权限隐藏"}</td>
        <td>应收：{hrCashStates[row.receiptState]}<small>应付：{hrCashStates[row.paymentState]}</small></td><td>{row.commissionEligible ? "可在已回款视图人工核定" : "尚不符合回款口径"}</td></tr>)}
        {!data.pagination.items.length&&<tr><td colSpan={10} className="empty-state">当前筛选下没有授权范围内的委托；可清除筛选查看其他日期。</td></tr>}
      </tbody></table></div><QueryPagination {...data.pagination} unit="票委托"/>
    <p className="readonly-note">报价商务取订单保存的姓名快照，未记录的不猜填。核销仅统计有效资金流水分配到本单费用的金额；登记了流水但未核销不算已回款。</p>
  </div>;
}
