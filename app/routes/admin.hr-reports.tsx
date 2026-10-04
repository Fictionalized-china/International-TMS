import { env } from "cloudflare:workers";
import { Form,Link,useNavigation,useNavigate } from "react-router";
import type { Route } from "./+types/admin.hr-reports";
import { requireSessionUser } from "../lib/auth.server";
import { loadHrReport,saveCommission,summarizeHrReport } from "../lib/hr-reports.server";
import { loadBusinessProcessPolicy } from "../lib/business-process-policy.server";
import { policyEnabled } from "../lib/business-process-policy";
import { hrReportPeriod,reportCsv } from "../lib/hr-reports";
import { paginateList,readListPage } from "../lib/list-pagination";
import { QueryPagination } from "../components/QueryPagination";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { Modal } from "../components/Modal";
export async function loader({request}:Route.LoaderArgs) {
  const current=await requireSessionUser(request,"hr.report.view"),url=new URL(request.url),kind=url.searchParams.get("period")==="week"?"week":"month",defaults=hrReportPeriod(new Date(),kind),from=url.searchParams.get("from")||defaults.from,to=url.searchParams.get("to")||defaults.to;
  const policy=await loadBusinessProcessPolicy(current.organizationId),enabled=policyEnabled(policy,"hr.reports_enabled");
  const rows=await loadHrReport(env.DB,current,from,to);
  if(url.searchParams.get("export")==="1") {
    if(!current.permissions.includes("data.export")) throw new Response("没有导出权限",{status:403});
    const body=reportCsv([["订单","业务员","回款日","业务状态","主车号","换装车号","发车批次","确认收入CNY","直接成本CNY","毛利CNY","提成CNY","发放状态","发放日期"],...rows.map(r=>[r.order_number,r.salesperson_name,r.paid_on,r.status,r.main_plates,r.transloading_plates,r.departure_count,r.revenue,r.cost,r.profit,r.commission_amount,r.commission_status==="paid"?"已发放":"未发放",r.commission_paid_on])]);
    return new Response(body,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="hr-paid-orders-${from}-${to}.csv"`,"Cache-Control":"no-store"}});
  }
  const snapshots=current.dataScope==="company"?(await env.DB.prepare("SELECT period_kind,date_from,date_to,created_at FROM hr_report_snapshots WHERE organization_id=? ORDER BY created_at DESC LIMIT 12").bind(current.organizationId).all<{period_kind:string;date_from:string;date_to:string;created_at:string}>()).results:[];
  return {current,enabled,from,to,kind,pagination:paginateList(rows,readListPage(url.searchParams)),total:rows.length,totalProfit:current.permissions.includes("hr.report.amount.view")?rows.reduce((sum,r)=>sum+Number(r.profit),0):null,summary:summarizeHrReport(rows),snapshots};
}
export async function action({request}:Route.ActionArgs) {
  const current=await requireSessionUser(request,"hr.commission.manage"),form=await request.formData(),v=(key:string)=>String(form.get(key)??"");
  try {await saveCommission(env.DB,{current,orderId:v("orderId"),amount:Number(v("amount")),status:v("status"),paidOn:v("paidOn"),notes:v("notes"),revision:Number(v("revision"))});return {success:"提成记录已保存，修改历史保留。",savedAt:crypto.randomUUID()};}
  catch(error){return {formError:error instanceof Error?error.message:"保存失败"};}
}
export default function HrReports({loaderData,actionData}:Route.ComponentProps) {
  const busy=useNavigation().state!=="idle",data=loaderData,navigate=useNavigate();
  return <div className="module-business-stack"><header className="page-header"><div><h1>人事回款与提成报表</h1><p>按实际核销统计已全部回款订单；毛利排除过关税费、赔偿等异常费用。提成由有权限人员填写，金额统一 CNY。</p></div></header>
    {actionData?.formError&&<p className="alert danger" role="alert">{actionData.formError}</p>}{actionData?.success&&<p className="alert success" role="status">{actionData.success}</p>}
    {data.current.permissions.includes('order.intake.manage')&&<Link className="secondary" to="/admin/quotations?entryMode=direct">紧急协助录单（仍须操作主管审批）</Link>}
    {!data.enabled&&<p className="alert">人事登记功能已停用，历史报表仍可查看。</p>}
    <Form key={`${data.kind}-${data.from}-${data.to}`} method="get" className="tracking-center-filter"><label>周期<select name="period" defaultValue={data.kind} onChange={e=>navigate(`?period=${e.target.value}`)}><option value="week">本周</option><option value="month">本月</option></select></label><label>回款开始日<input type="date" name="from" defaultValue={data.from}/></label><label>回款结束日<input type="date" name="to" defaultValue={data.to}/></label><button className="primary">查询</button>{data.current.permissions.includes("data.export")&&<Link className="secondary" reloadDocument to={`?from=${data.from}&to=${data.to}&export=1`}>导出 Excel 可打开的 CSV</Link>}</Form>
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
