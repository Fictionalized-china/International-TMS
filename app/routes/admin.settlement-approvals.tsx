import { env } from "cloudflare:workers";
import { Form,Link,useNavigation } from "react-router";
import type { Route } from "./+types/admin.settlement-approvals";
import { requireSessionUser } from "../lib/auth.server";
import { AdminWorkspaceTabs } from "../components/AdminWorkspaceTabs";
import { OrderSettlementSignoffs } from "../components/OrderSettlementSignoffs";
import { SettlementHandoff } from "../components/SettlementHandoff";
import { loadSettlementHandoff } from "../lib/financial-closure.server";
import { reopenPrematureSettlement } from "../lib/settlement-recovery.server";
import { canViewAdminNavigationItem } from "../lib/admin-navigation";
import { orderVisibilitySql } from "../lib/order-access";
import { loadMeetingSettlement,loadMeetingSettlementDirections,submitMeetingSignature,actualExportSql,assertMeetingSignoffsComplete } from "../lib/meeting-settlement.server";
import { refreshMeetingSettlement } from "../lib/meeting-settlement-refresh.server";
import type { ExpenseDirectionAction } from "../lib/expense-control";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { QueryPagination } from "../components/QueryPagination";
import { Modal } from "../components/Modal";
import { paginateList,readListPage } from "../lib/list-pagination";
import { isBossBusinessActor } from "../lib/permission-blocks";
export async function loader({request}:Route.LoaderArgs) {
  const current=await requireSessionUser(request,"order.view"),scope=orderVisibilitySql(current,"o"),url=new URL(request.url),q=(url.searchParams.get("q")??"").trim();
  const orders=await env.DB.prepare(`SELECT o.id FROM transport_orders o WHERE o.organization_id=? AND ${scope.sql} AND o.status='in_execution' AND (${actualExportSql()} OR o.current_step_name LIKE '对账结算%') ${q?"AND o.order_number LIKE ?":""} ORDER BY o.updated_at DESC`).bind(current.organizationId,...scope.values,...(q?[`%${q}%`]:[])).all<{id:string}>();
  const page=paginateList(orders.results,readListPage(url.searchParams));
  const rows=[];
  for(const order of page.items) {
    const state=await loadMeetingSettlement(env.DB,current.organizationId,order.id);
    const directions=await loadMeetingSettlementDirections(env.DB,current.organizationId,order.id,state,current);
    const offline=await env.DB.prepare("SELECT approver_name,approved_at,evidence_reference FROM order_payable_offline_approvals WHERE organization_id=? AND order_id=?").bind(current.organizationId,order.id).first<{approver_name:string;approved_at:string;evidence_reference:string}>();
    const handoff=await loadSettlementHandoff(env.DB,state,current,directions);
    rows.push({id:order.id,orderNumber:state.order.order_number,open:state.open,directions,offline,handoff,payableMissing:!directions.find(item=>item.direction==='payable')?.hasExpenses,canRecordOffline:state.open&&handoff.canRecordOffline});
  }
  return {current,rows,pagination:page,q};
}
export async function action({request}:Route.ActionArgs) {
  const current=await requireSessionUser(request,"order.view"),form=await request.formData(),v=(key:string)=>String(form.get(key)??"");
  try {
    if(v("intent")==="settlement_reopen") return {...await reopenPrematureSettlement(env.DB,current,v("orderId"),v("confirmed")==="1"),savedAt:crypto.randomUUID(),formError:undefined};
    if(v("intent")==="offline") {
      const scope=orderVisibilitySql(current,"o");if(!await env.DB.prepare(`SELECT 1 FROM transport_orders o WHERE o.id=? AND o.organization_id=? AND ${scope.sql}`).bind(v("orderId"),current.organizationId,...scope.values).first()) throw new Error("订单不在当前读取范围");
      const state=await loadMeetingSettlement(env.DB,current.organizationId,v("orderId"));
      if(!state.open || (!isBossBusinessActor(current)&&(state.order.finance_user_id!==current.userId || !current.permissions.includes("settlement.offline_approval.record")))) throw new Error("仅本单财务负责人可记录线下付款审批");
      await assertMeetingSignoffsComplete(env.DB,current.organizationId,[v("orderId")],"payable");
      if(!v("approver").trim()||!v("evidence").trim()||!Number.isFinite(Date.parse(v("approvedAt")))) throw new Error("请填写实际审批人、日期和凭证编号");
      const now=new Date().toISOString();if(Date.parse(v("approvedAt"))>Date.now()+300000) throw new Error("审批日期不能晚于当前时间");
      await env.DB.batch([env.DB.prepare("INSERT INTO order_payable_offline_approvals(id,organization_id,order_id,approver_name,approved_at,evidence_reference,recorded_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,order_id) DO NOTHING").bind(crypto.randomUUID(),current.organizationId,v("orderId"),v("approver").trim(),v("approvedAt"),v("evidence").trim(),current.userId,now),env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'settlement.offline_approval.record','transport_order',?,'success',?,?)").bind(crypto.randomUUID(),current.organizationId,current.userId,v("orderId"),JSON.stringify({approver:v("approver"),evidence:v("evidence")}),now)]);
    }else {
      if(!["receivable","payable"].includes(v("direction"))||!["confirm","business_review","finance_review"].includes(v("action"))) throw new Error("签核参数无效");
      await submitMeetingSignature(env.DB,{current,orderId:v("orderId"),direction:v("direction") as "receivable"|"payable",action:v("action") as ExpenseDirectionAction,notes:v("notes"),refresh:()=>refreshMeetingSettlement(current.organizationId,v("orderId"))});
    }
    return {success:"记录已保存；运输流程不受对账办理影响。",savedAt:crypto.randomUUID()};
  }catch(error){return {formError:error instanceof Error?error.message:"签核失败"};}
}
export default function SettlementApprovals({loaderData,actionData}:Route.ComponentProps) {
  const busy=useNavigation().state!=="idle";
  return <div className="module-business-stack"><header className="page-header"><div><h1>费用结算 · 待我审批</h1><p>分别办理客户应收与供应商应付；可办步骤由工作流控制，办理岗位由业务策略配置，个人责任由本单任务分派决定。</p></div></header>
    <AdminWorkspaceTabs user={loaderData.current} workspace="billing" />
    {actionData?.formError&&<p role="alert" className="alert danger">{actionData.formError}</p>}{actionData?.success&&<p role="status" className="alert success">{actionData.success}</p>}
    <Form method="get" className="tracking-center-filter"><label>订单定位<input name="q" defaultValue={loaderData.q}/></label><button className="primary">查询</button></Form>
    {loaderData.rows.map(row=><section className="panel" key={row.id}><h2><OrderNumberLink id={row.id} number={row.orderNumber}/></h2><OrderSettlementSignoffs orderId={row.id} directions={row.directions} busy={busy}/>
      {row.offline?<p>线下付款审批：{row.offline.approver_name} · {row.offline.approved_at} · {row.offline.evidence_reference}</p>:row.canRecordOffline?<Modal title="记录总经理线下审批" triggerLabel="记录线下付款审批" closeSignal={actionData?.savedAt}><Form method="post" className="form-grid"><input type="hidden" name="intent" value="offline"/><input type="hidden" name="orderId" value={row.id}/><label>审批人<input name="approver" required/></label><label>实际审批日期<input type="date" name="approvedAt" required/></label><label>凭证 / 记录编号<input name="evidence" required/></label><button className="primary" disabled={busy}>保存审批记录</button></Form></Modal>:<p>线下付款审批记录待财务登记。</p>}
      {row.payableMissing&&<p className="alert warning">尚无应付费用，请通知操作或商务补录；不阻断独立应收对账。</p>}
      <SettlementHandoff data={row.handoff} orderId={row.id} orderNumber={row.orderNumber} busy={busy}/>
      <div className="row-actions">{canViewAdminNavigationItem(loaderData.current, "billing") && <Link to={`/admin/billing?q=${encodeURIComponent(row.orderNumber)}`}>查看确认、对账与发票状态</Link>}<Link to={`/admin/orders/${row.id}?module=documents&stage=outbound_transport`}>查看报关与出境资料</Link></div>
    </section>)}{!loaderData.rows.length&&<p className="empty-state">当前范围内尚无已实际出境订单。</p>}<QueryPagination {...loaderData.pagination} unit="票订单"/></div>;
}
