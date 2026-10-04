import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled } from "./business-process-policy";
import { isExcludedFromGrossProfit } from "./financial-analytics";
import { chunkD1Values,d1Placeholders } from "./d1-bindings";
import { hrReportPeriod } from "./hr-reports";
export type HrReportRow={id:string;order_number:string;salesperson_name:string|null;status:string;paid_on:string;main_plates:string|null;transloading_plates:string|null;departure_count:number;departure_ids:string|null;cost_pending:boolean;revenue:number|null;cost:number|null;profit:number|null;commission_amount:number|null;commission_status:string;commission_paid_on:string|null;commission_revision:number};
export async function loadHrReport(db:D1Database,current:SessionUser,from:string,to:string) {
  if(!current.permissions.includes("hr.report.view")) throw new Error("没有人事报表权限");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||from>to) throw new Error("统计日期范围无效");
  const scope=orderVisibilitySql(current,"o");
  const candidates=await db.prepare(`SELECT o.id,o.order_number,sales.display_name salesperson_name,o.status,
    (SELECT MAX(t.occurred_on) FROM settlement_cash_allocations a JOIN business_expenses e ON e.id=a.expense_id AND e.organization_id=a.organization_id JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id AND t.status!='void' WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.direction='receivable') paid_on,
    (SELECT GROUP_CONCAT(DISTINCT a.plate_number) FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.status!='cancelled') main_plates,
    (SELECT GROUP_CONCAT(DISTINCT d.vehicle_reference) FROM order_daily_tracking d WHERE d.organization_id=o.organization_id AND d.order_id=o.id AND d.event_kind='transloading_vehicle') transloading_plates,
    (SELECT GROUP_CONCAT(DISTINCT b.id) FROM transport_batches b WHERE b.organization_id=o.organization_id AND b.actual_departure_at IS NOT NULL AND b.status!='cancelled' AND (b.order_id=o.id OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.order_id=o.id AND bo.status!='removed'))) departure_ids,
    (SELECT COUNT(DISTINCT b.id) FROM transport_batches b WHERE b.organization_id=o.organization_id AND b.actual_departure_at IS NOT NULL AND b.status!='cancelled' AND (b.order_id=o.id OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.order_id=o.id AND bo.status!='removed'))) departure_count,
    cr.amount commission_amount,COALESCE(cr.status,'pending') commission_status,cr.paid_on commission_paid_on,COALESCE(cr.revision,0) commission_revision
    FROM transport_orders o LEFT JOIN users sales ON sales.id=o.salesperson_user_id LEFT JOIN order_commission_records cr ON cr.organization_id=o.organization_id AND cr.order_id=o.id
    WHERE o.organization_id=? AND ${scope.sql} AND o.status NOT IN ('draft','submitted','cancelled') ORDER BY o.order_number`).bind(current.organizationId,...scope.values).all<Omit<HrReportRow,"revenue"|"cost"|"profit">>();
  // Resource plates are attached to a batch, not duplicated into every child order.
  const batchPlates=await db.prepare(`SELECT b.id,b.order_id,b.overseas_vehicle_plate,v.plate_number,bo.order_id child_order_id FROM transport_batches b LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled' LEFT JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed' WHERE b.organization_id=? AND b.status!='cancelled'`).bind(current.organizationId).all<{id:string;order_id:string;child_order_id:string|null;plate_number:string|null;overseas_vehicle_plate:string|null}>();
  const joinPlates=(existing:string|null,added:(string|null)[])=>[...new Set([...(existing||'').split(','),...added].filter((v):v is string=>Boolean(v?.trim())))].join(',')||null;
  for(const row of candidates.results) {
    const resources=batchPlates.results.filter(b=>b.order_id===row.id||b.child_order_id===row.id);
    row.main_plates=joinPlates(row.main_plates,resources.map(b=>b.plate_number));
    row.transloading_plates=joinPlates(row.transloading_plates,resources.map(b=>b.overseas_vehicle_plate));
  }
  const amounts=new Map<string,{revenue:number;cost:number;profit:number;outstanding:number;receivableCount:number;unconfirmedCount:number;payableCount:number;pendingPayable:number}>();
  for(const chunk of chunkD1Values(candidates.results.map(row=>row.id),1)) {
    const expenses=await db.prepare(`SELECT e.order_id,e.direction,e.stage,e.amount,e.exchange_rate,e.charge_code,e.charge_name,
      COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id AND t.status!='void' WHERE a.organization_id=e.organization_id AND a.expense_id=e.id),0) collected
      FROM business_expenses e WHERE e.organization_id=? AND e.order_id IN (${d1Placeholders(chunk.length)}) AND e.stage!='cancelled'`).bind(current.organizationId,...chunk).all<{order_id:string;direction:string;stage:string;amount:number;exchange_rate:number;charge_code:string;charge_name:string;collected:number}>();
    for(const fee of expenses.results) {
      const a=amounts.get(fee.order_id)??{revenue:0,cost:0,profit:0,outstanding:0,receivableCount:0,unconfirmedCount:0,payableCount:0,pendingPayable:0};
      const value=Number(fee.amount)*Number(fee.exchange_rate),confirmed=fee.stage!=="estimated";
      if(fee.direction==="receivable") {a.receivableCount++;a.outstanding+=Math.max(0,Number(fee.amount)-Number(fee.collected));if(!confirmed)a.unconfirmedCount++;if(confirmed)a.revenue+=value;}
      else if(!isExcludedFromGrossProfit(fee.charge_code,fee.charge_name)) {a.payableCount++;if(!confirmed)a.pendingPayable++;else a.cost+=value;}
      a.profit=a.revenue-a.cost;amounts.set(fee.order_id,a);
    }
  }
  const sensitive=current.permissions.includes("hr.report.amount.view");
  return candidates.results.filter(row=>{const a=amounts.get(row.id);return a&&a.receivableCount>0&&a.unconfirmedCount===0&&a.outstanding<=0.009&&row.paid_on>=from&&row.paid_on<=to;}).map(row=>{const a=amounts.get(row.id)!,pending=a.pendingPayable>0||a.payableCount===0;return {...row,cost_pending:pending,commission_amount:sensitive?Number(row.commission_amount??0):null,revenue:sensitive?a.revenue:null,cost:sensitive?a.cost:null,profit:sensitive&&!pending?a.profit:null};});
}
export function summarizeHrReport(rows:readonly HrReportRow[]) {
  const departures=new Set(rows.flatMap(r=>(r.departure_ids||'').split(',').filter(Boolean)));
  const teams=new Map<string,{name:string;orders:number;completed:number;profit:number;pendingCost:number;commissionPaid:number}>();
  for(const row of rows){const name=row.salesperson_name||'未指定业务员',group=teams.get(name)??{name,orders:0,completed:0,profit:0,pendingCost:0,commissionPaid:0};group.orders++;if(row.status==='completed')group.completed++;if(row.cost_pending)group.pendingCost++;group.profit+=row.profit??0;if(row.commission_status==='paid')group.commissionPaid+=row.commission_amount??0;teams.set(name,group);}
  return {completed:rows.filter(r=>r.status==='completed').length,departures:departures.size,pendingCost:rows.filter(r=>r.cost_pending).length,teams:[...teams.values()]};
}
export async function saveCommission(db:D1Database,input:{current:SessionUser;orderId:string;amount:number;status:string;paidOn:string;notes:string;revision:number}) {
  if(!input.current.permissions.includes("hr.commission.manage")||!input.current.permissions.includes("hr.report.amount.view")) throw new Error("提成登记须同时具有金额查看与登记权限");
  const policy=await loadBusinessProcessPolicy(input.current.organizationId,db);if(!policyEnabled(policy,"hr.reports_enabled")) throw new Error("人事报表登记已停用，历史保留");
  if(!Number.isSafeInteger(input.revision)||input.revision<0||!Number.isFinite(input.amount)||input.amount<0||!["pending","paid"].includes(input.status)||input.notes.length>2000||(input.status==="paid"&&(!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)||!Number.isFinite(Date.parse(input.paidOn))))) throw new Error("提成金额、版本或发放日期无效");
  const scope=orderVisibilitySql(input.current,"o");if(!await db.prepare(`SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND ${scope.sql}`).bind(input.current.organizationId,input.orderId,...scope.values).first()) throw new Error("订单不在当前权限范围");
  const now=new Date().toISOString(),revision=input.revision+1,token=crypto.randomUUID();
  const result=await db.batch([db.prepare(`INSERT INTO order_commission_records(organization_id,order_id,amount,status,paid_on,notes,revision,updated_by_user_id,updated_at,write_token) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM order_commission_records WHERE organization_id=? AND order_id=? AND revision=?))
    ON CONFLICT(organization_id,order_id) DO UPDATE SET amount=excluded.amount,status=excluded.status,paid_on=excluded.paid_on,notes=excluded.notes,revision=excluded.revision,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at,write_token=excluded.write_token WHERE order_commission_records.revision=?`).bind(input.current.organizationId,input.orderId,input.amount,input.status,input.status==="paid"?input.paidOn:null,input.notes,revision,input.current.userId,now,token,input.revision,input.current.organizationId,input.orderId,input.revision,input.revision),
    db.prepare(`INSERT INTO order_commission_history(id,organization_id,order_id,amount,status,paid_on,notes,revision,actor_user_id,created_at) SELECT ?,organization_id,order_id,amount,status,paid_on,notes,revision,updated_by_user_id,updated_at FROM order_commission_records WHERE organization_id=? AND order_id=? AND write_token=?`).bind(crypto.randomUUID(),input.current.organizationId,input.orderId,token)]);
  if(!Number(result[0].meta.changes)) throw new Error("提成记录已由其他人修改，请刷新后重试");
}
export async function generateScheduledHrReports(db:D1Database,org:string,now=new Date()) {
  const policy=await loadBusinessProcessPolicy(org,db);if(!policyEnabled(policy,"hr.reports_enabled")) return {created:0};
  let created=0;
  for(const kind of ["week","month"] as const) {
    const dates=hrReportPeriod(now,kind,true);
    if(await db.prepare("SELECT 1 FROM hr_report_snapshots WHERE organization_id=? AND period_kind=? AND date_from=? AND date_to=?").bind(org,kind,dates.from,dates.to).first()) continue;
    const system:SessionUser={organizationId:org,userId:"scheduled",sessionId:"scheduled",organizationName:"",email:"",displayName:"定时任务",site:"admin",departmentId:null,departmentCode:null,warehouseIds:[],regionCountryCodes:[],positionCode:null,roleCodes:[],permissions:["hr.report.view","hr.report.amount.view"],dataScope:"company"};
    const rows=await loadHrReport(db,system,dates.from,dates.to);
    const result=await db.prepare("INSERT OR IGNORE INTO hr_report_snapshots(id,organization_id,period_kind,date_from,date_to,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(crypto.randomUUID(),org,kind,dates.from,dates.to,JSON.stringify(rows),now.toISOString()).run();created+=Number(result.meta.changes)>0?1:0;
  }
  return {created};
}
