import { env } from "cloudflare:workers";
import { evaluateOrderIntakeCompleteness, type CurrentOrderIntakeFacts } from "./order-intake-completeness";
import { boundIntakePolicy, readIntakeRuleBinding, type IntakeRuleBinding } from "./order-intake-rule";
import { predicateGuard } from "./mutation-guard.server";
import { chunkD1Rows,chunkD1Values,d1Placeholders } from "./d1-bindings";

const orderColumns = ["customer_id", "business_type", "transport_mode", "salesperson_user_id", "quote_commercial_user_id", "quote_commercial_name_snapshot", "origin_country", "origin_state", "origin_city", "destination_country", "destination_state", "destination_city", "exit_port", "transit_locations", "customs_location", "domestic_agent", "declared_quantity_unit", "intake_operations_json"];
const cargoColumns = ["id", "cargo_name_cn", "declared_quantity", "declared_unit", "package_count", "pieces_per_package", "gross_weight_per_package_kg", "volume_per_package_cbm"];
const expenseColumns = ["id", "direction", "stage", "charge_code", "charge_name", "counterparty_name", "currency", "quantity", "unit_price", "amount", "exchange_rate", "base_amount"];
const serviceColumns = ["id", "service_code", "status"];
const numericColumns=new Set(["declared_quantity","package_count","pieces_per_package","gross_weight_per_package_kg","volume_per_package_cbm","quantity","unit_price","amount","exchange_rate","base_amount"]);
type Value = string | number | null;
export async function readIntakeGateSnapshot(organizationId: string, orderId: string, bindingOverride?: IntakeRuleBinding,db:D1Database=env.DB) {
  const order = await db.prepare(`SELECT ${orderColumns.join(",")} FROM transport_orders WHERE organization_id=? AND id=?`).bind(organizationId, orderId).first<Record<string, unknown>>();
  if (!order) throw new Error("订单不存在或不属于当前组织");
  const binding = bindingOverride ?? readIntakeRuleBinding(order.intake_operations_json);
  // Even a legacy decision must not race an explicit rule upgrade in another window.
  if (!binding) return { organizationId, orderId, binding: null, facts: { order, cargo: [], expenses: [], services: [] } as CurrentOrderIntakeFacts, result: null };
  const [cargo, expenses, services] = await Promise.all([
    db.prepare(`SELECT ${cargoColumns.join(",")} FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no,id`).bind(organizationId, orderId).all<Record<string, unknown>>(),
    db.prepare(`SELECT ${expenseColumns.join(",")} FROM business_expenses WHERE organization_id=? AND order_id=? AND stage!='cancelled' ORDER BY created_at,id`).bind(organizationId, orderId).all<Record<string, unknown>>(),
    db.prepare(`SELECT ${serviceColumns.join(",")} FROM order_services WHERE organization_id=? AND order_id=? ORDER BY id`).bind(organizationId, orderId).all<Record<string, unknown>>(),
  ]);
  const facts: CurrentOrderIntakeFacts = { order, cargo: cargo.results, expenses: expenses.results, services: services.results };
  const result = evaluateOrderIntakeCompleteness(facts, boundIntakePolicy(binding), binding.requiredKeys);
  return { organizationId, orderId, binding, facts, result };
}
export type IntakeGateSnapshot = NonNullable<Awaited<ReturnType<typeof readIntakeGateSnapshot>>> & {batchMembership?:{batchId:string;orderIds:string[];headerOnly:boolean};dispatchMembership?:{dispatchId:string;orderIds:string[]}};
/** Batch loading avoids four new queries per child in a 50-order consolidation. */
export async function prepareOrdersIntakeAdvance(organizationId:string,orderIds:readonly string[]) {
  const snapshots:IntakeGateSnapshot[]=[];
  for(const ids of chunkD1Values([...new Set(orderIds)],1)){
    const orders=(await env.DB.prepare(`SELECT id,order_number,${orderColumns.join(",")} FROM transport_orders WHERE organization_id=? AND id IN (${d1Placeholders(ids.length)})`).bind(organizationId,...ids).all<Record<string,unknown>>()).results;
    if(orders.length!==ids.length)throw new Error("批次包含不存在或不属于本组织的订单，不能继续办理");
    const bound=orders.map(order=>({order,binding:readIntakeRuleBinding(order.intake_operations_json)}));
    const active=bound.filter(row=>row.binding).map(row=>String(row.order.id));
    const tables=active.length?await Promise.all([
      env.DB.prepare(`SELECT order_id,${cargoColumns.join(",")} FROM order_cargo_items WHERE organization_id=? AND order_id IN (${d1Placeholders(active.length)}) ORDER BY line_no,id`).bind(organizationId,...active).all<Record<string,unknown>>(),
      env.DB.prepare(`SELECT order_id,${expenseColumns.join(",")} FROM business_expenses WHERE organization_id=? AND order_id IN (${d1Placeholders(active.length)}) AND stage!='cancelled' ORDER BY created_at,id`).bind(organizationId,...active).all<Record<string,unknown>>(),
      env.DB.prepare(`SELECT order_id,${serviceColumns.join(",")} FROM order_services WHERE organization_id=? AND order_id IN (${d1Placeholders(active.length)}) ORDER BY id`).bind(organizationId,...active).all<Record<string,unknown>>(),
    ]):[];
    const indexed=tables.map(table=>{const map=new Map<string,Record<string,unknown>[]>();for(const row of table.results){const id=String(row.order_id),rows=map.get(id)??[];rows.push(row);map.set(id,rows);}return map;});
    for(const {order,binding}of bound){
      const orderId=String(order.id),facts:CurrentOrderIntakeFacts={order,cargo:indexed[0]?.get(orderId)??[],expenses:indexed[1]?.get(orderId)??[],services:indexed[2]?.get(orderId)??[]};
      snapshots.push(binding?{organizationId,orderId,binding,facts,result:evaluateOrderIntakeCompleteness(facts,boundIntakePolicy(binding),binding.requiredKeys)}:{organizationId,orderId,binding:null,facts,result:null});
    }
  }
  const blocked=snapshots.filter(snapshot=>snapshot.result&&!snapshot.result.knownFieldsSatisfied);
  if(blocked.length)throw new Error(blocked.map(snapshot=>`${snapshot.facts.order.order_number??snapshot.orderId}：${intakeGateMessage(snapshot)}`).join("\n"));
  return snapshots;
}
export async function prepareBatchIntakeAdvance(organizationId:string,batchId:string){
  const rows=(await env.DB.prepare(`SELECT order_id,'child' source FROM transport_batch_orders WHERE organization_id=? AND batch_id=? AND status!='removed'
    UNION SELECT b.order_id,'header' source FROM transport_batches b WHERE b.organization_id=? AND b.id=? AND b.order_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=b.organization_id AND bo.batch_id=b.id AND bo.status!='removed')`)
    .bind(organizationId,batchId,organizationId,batchId).all<{order_id:string;source:string}>()).results;
  if(!rows.length)throw new Error("本批次没有有效订单，不能继续办理");
  const snapshots=await prepareOrdersIntakeAdvance(organizationId,rows.map(row=>row.order_id));
  snapshots[0].batchMembership={batchId,orderIds:rows.map(row=>row.order_id),headerOnly:rows[0].source==='header'};
  return snapshots;
}
export const intakeManyCommitStatements=(snapshots:readonly IntakeGateSnapshot[],now:string)=>snapshots.flatMap(snapshot=>intakeGateCommitStatements(snapshot,now));
const dispatchMembershipFrom=`FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id WHERE di.organization_id=? AND di.dispatch_id=?`;
export async function prepareDispatchIntakeAdvance(organizationId:string,dispatchId:string){
  const rows=(await env.DB.prepare(`SELECT DISTINCT s.order_id ${dispatchMembershipFrom}`).bind(organizationId,dispatchId).all<{order_id:string}>()).results;
  if(!rows.length)throw new Error("装车任务没有有效订单，不能继续办理");
  const orderIds=rows.map(row=>row.order_id),snapshots=await prepareOrdersIntakeAdvance(organizationId,orderIds);
  snapshots[0].dispatchMembership={dispatchId,orderIds};return snapshots;
}
export function intakeGateMessage(snapshot: IntakeGateSnapshot) {
  return `开单必填资料尚未补齐，不能进入下一节点：${snapshot.result?.issues.map(issue => `${issue.rowNumber ? `第${issue.rowNumber}条${issue.source === "cargo" ? "货物" : "费用"}·` : ""}${issue.label}（${issue.reason}）`).join("；")}。请在订单内补录；无需重录已有资料。`;
}
/** Evaluate once per actual submission; the returned predicates run in its business transaction. */
export async function prepareOrderIntakeAdvance(organizationId: string, orderId: string,db:D1Database=env.DB) {
  const snapshot = await readIntakeGateSnapshot(organizationId, orderId,undefined,db);
  if (snapshot.result && !snapshot.result.knownFieldsSatisfied) throw new Error(intakeGateMessage(snapshot));
  return snapshot;
}
export function intakeGateCommitStatements(snapshot: IntakeGateSnapshot | null, now: string,db:D1Database=env.DB) {
  if (!snapshot) return [];
  const { organizationId, orderId, facts } = snapshot;
  const values: Value[] = [organizationId, orderId];
  const same = (columns: readonly string[], row: Record<string, unknown>, destination: Value[]) => columns.map(column => {
    const value = row[column] == null ? null : row[column] as string | number;
    destination.push(value, value);
    // Text comparisons must not depend on MySQL's case-insensitive collation;
    // decimals remain numeric so driver number/string representations agree.
    return `(${numericColumns.has(column)?`${column}=?`:`HEX(${column})=HEX(?)`} OR (${column} IS NULL AND ? IS NULL))`;
  }).join(" AND ");
  const orderPredicate = same(orderColumns, facts.order, values);
  const statements = [predicateGuard(db, `EXISTS(SELECT 1 FROM transport_orders WHERE organization_id=? AND id=? AND ${orderPredicate})`, values, now)];
  if(snapshot.batchMembership){
    const member=snapshot.batchMembership;
    statements.push(predicateGuard(db,"(SELECT COUNT(*) FROM transport_batch_orders WHERE organization_id=? AND batch_id=? AND status!='removed')=?",[organizationId,member.batchId,member.headerOnly?0:member.orderIds.length],now));
    if(member.headerOnly)statements.push(predicateGuard(db,"EXISTS(SELECT 1 FROM transport_batches WHERE organization_id=? AND id=? AND order_id=?)",[organizationId,member.batchId,member.orderIds[0]],now));
    else for(const ids of chunkD1Values(member.orderIds,5))statements.push(predicateGuard(db,`(SELECT COUNT(*) FROM transport_batch_orders WHERE organization_id=? AND batch_id=? AND status!='removed' AND order_id IN (${d1Placeholders(ids.length)}))=?`,[organizationId,member.batchId,...ids,ids.length],now));
  }
  if(snapshot.dispatchMembership){
    const member=snapshot.dispatchMembership;
    statements.push(predicateGuard(db,`(SELECT COUNT(DISTINCT s.order_id) ${dispatchMembershipFrom})=?`,[organizationId,member.dispatchId,member.orderIds.length],now));
    for(const ids of chunkD1Values(member.orderIds,5))statements.push(predicateGuard(db,`(SELECT COUNT(DISTINCT s.order_id) ${dispatchMembershipFrom} AND s.order_id IN (${d1Placeholders(ids.length)}))=?`,[organizationId,member.dispatchId,...ids,ids.length],now));
  }
  if (!snapshot.binding) return statements;
  for (const [table, columns, rows, filter] of [
    ["order_cargo_items", cargoColumns, facts.cargo, ""],
    ["business_expenses", expenseColumns, facts.expenses, " AND stage!='cancelled'"],
    ["order_services", serviceColumns, facts.services, ""],
  ] as const) {
    statements.push(predicateGuard(db, `(SELECT COUNT(*) FROM ${table} WHERE organization_id=? AND order_id=?${filter})=?`, [organizationId, orderId, rows.length], now));
    for (const group of chunkD1Rows(rows, columns.length * 2, 5)) {
      const bindings: Value[] = [organizationId, orderId];
      const matching = group.map(row => `(${same(columns, row, bindings)})`).join(" OR ");
      bindings.push(group.length);
      statements.push(predicateGuard(db, `(SELECT COUNT(*) FROM ${table} WHERE organization_id=? AND order_id=?${filter} AND (${matching}))=?`, bindings, now));
    }
  }
  return statements;
}
