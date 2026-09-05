import type{AllocationMethod}from"./cost-allocation";
import{allocateCost,allocationDensity,recommendAllocationMethod}from"./cost-allocation";

export type CostAllocationLine={
  id:string;order_id:string;order_number:string;customer_name:string;
  actual_weight_kg:number;actual_volume_cbm:number;suggested_ratio:number;
  suggested_amount:number;adjusted_amount:number|null;adjustment_reason:string|null;
  final_amount:number;expense_id:string|null;
};

export type CostAllocation={
  id:string;batch_id:string;charge_code:string;charge_name:string;counterparty_name:string;
  currency:string;exchange_rate:number;total_amount:number;allocation_method:AllocationMethod;
  total_actual_weight_kg:number;total_actual_volume_cbm:number;density_kg_per_cbm:number;
  density_result:string;status:"draft"|"confirmed"|"cancelled";notes:string|null;
  confirmed_at:string|null;created_at:string;lines:CostAllocationLine[];
};

type ActualOrder={order_id:string;order_number:string;customer_name:string;receipt_count:number;actual_weight_kg:number;actual_volume_cbm:number};

export type BatchCostAllocationGateRow={
  order_id:string;
  order_number:string;
  order_status:string;
  workflow_instance_id:string|null;
  matched_instance_id:string|null;
  current_step_sort_order:number|null;
  last_cost_step_sort_order:number|null;
  costs_status:string|null;
  confirmed:number;
  business_reviewed:number;
  finance_reviewed:number;
  business_locked:number;
  finance_locked:number;
};

export function batchCostAllocationGateError(
  rows:readonly BatchCostAllocationGateRow[],
){
  if(!rows.length)return "配载单没有可办理费用分摊的有效订单";
  for(const row of rows){
    const label=row.order_number||row.order_id;
    if(["completed","cancelled"].includes(row.order_status))
      return `订单 ${label} 已完结或取消，不能继续新增、调整或确认配载费用`;
    if(!row.workflow_instance_id||!row.matched_instance_id||row.current_step_sort_order===null||row.last_cost_step_sort_order===null)
      return `订单 ${label} 的冻结工作流绑定或费用节点不完整，费用分摊已阻断`;
    if(row.current_step_sort_order>row.last_cost_step_sort_order)
      return `订单 ${label} 已越过冻结工作流的费用节点，不能再追加配载费用`;
    if(!row.costs_status||["completed","not_applicable"].includes(row.costs_status))
      return `订单 ${label} 的费用模块未开放或已经完成，不能继续办理配载费用`;
    if(
      row.confirmed||row.business_reviewed||row.finance_reviewed||
      row.business_locked||row.finance_locked
    )return `订单 ${label} 的应付费用已有签核或锁定结果，不能再追加配载费用`;
  }
  return null;
}

async function assertBatchCostAllocationOpen(
  db:D1Database,
  organizationId:string,
  batchId:string,
){
  const result=await db.prepare(`SELECT bo.order_id,o.order_number,o.status order_status,
      o.workflow_instance_id,wi.id matched_instance_id,
      current_step.sort_order current_step_sort_order,
      (SELECT MAX(cost_step.sort_order)
       FROM workflow_instance_step_states cost_step
       JOIN workflow_instance_module_states cost_module
         ON cost_module.instance_step_state_id=cost_step.id
        AND cost_module.module_code='costs'
       WHERE cost_step.instance_id=wi.id) last_cost_step_sort_order,
      costs.status costs_status,
      COALESCE(control.confirmed,0) confirmed,
      COALESCE(control.business_reviewed,0) business_reviewed,
      COALESCE(control.finance_reviewed,0) finance_reviewed,
      COALESCE(control.business_locked,0) business_locked,
      COALESCE(control.finance_locked,0) finance_locked
    FROM transport_batch_orders bo
    JOIN transport_orders o
      ON o.id=bo.order_id AND o.organization_id=bo.organization_id
    LEFT JOIN workflow_instances wi
      ON wi.id=o.workflow_instance_id
     AND wi.organization_id=o.organization_id
     AND wi.order_id=o.id
    LEFT JOIN workflow_instance_step_states current_step
      ON current_step.instance_id=wi.id AND current_step.step_key=wi.current_step_key
    LEFT JOIN order_module_instances costs
      ON costs.organization_id=o.organization_id AND costs.order_id=o.id
     AND costs.module_code='costs' AND costs.enabled=1
    LEFT JOIN order_expense_direction_controls control
      ON control.organization_id=o.organization_id AND control.order_id=o.id
     AND control.direction='payable'
    WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    ORDER BY bo.sequence_no,bo.order_id`)
    .bind(organizationId,batchId).all<BatchCostAllocationGateRow>();
  const error=batchCostAllocationGateError(result.results);
  if(error)throw new Error(error);
  return result.results;
}

export async function loadCostAllocations(db:D1Database,organizationId:string,batchId:string){
  const headers=await db.prepare(`SELECT id,batch_id,charge_code,charge_name,counterparty_name,currency,exchange_rate,total_amount,allocation_method,total_actual_weight_kg,total_actual_volume_cbm,density_kg_per_cbm,density_result,status,notes,confirmed_at,created_at FROM transport_cost_allocations WHERE organization_id=? AND batch_id=? AND status!='cancelled' ORDER BY created_at DESC`).bind(organizationId,batchId).all<Omit<CostAllocation,"lines">>();
  const result:CostAllocation[]=[];
  for(const header of headers.results){
    const lines=await db.prepare(`SELECT l.id,l.order_id,o.order_number,c.name customer_name,l.actual_weight_kg,l.actual_volume_cbm,l.suggested_ratio,l.suggested_amount,l.adjusted_amount,l.adjustment_reason,l.final_amount,l.expense_id FROM transport_cost_allocation_lines l JOIN transport_orders o ON o.id=l.order_id JOIN customers c ON c.id=o.customer_id WHERE l.organization_id=? AND l.allocation_id=? ORDER BY o.order_number`).bind(organizationId,header.id).all<CostAllocationLine>();
    result.push({...header,lines:lines.results});
  }
  return result;
}

export async function createCostAllocation(db:D1Database,input:{
  organizationId:string;batchId:string;chargeCode:string;chargeName:string;counterpartyName:string;
  currency:string;exchangeRate:number;totalAmount:number;method:"auto"|AllocationMethod;notes?:string;
  userId:string;now:string;
}){
  if(!input.chargeCode||!input.chargeName||!input.counterpartyName)throw new Error("请填写费用项目和往来单位");
  if(!Number.isFinite(input.totalAmount)||input.totalAmount<=0)throw new Error("分摊总金额必须大于 0");
  if(!Number.isFinite(input.exchangeRate)||input.exchangeRate<=0)throw new Error("汇率必须大于 0");
  await assertBatchCostAllocationOpen(db,input.organizationId,input.batchId);
  const actuals=await loadBatchActuals(db,input.organizationId,input.batchId);
  const missing=actuals.filter(item=>item.receipt_count===0);
  if(missing.length)throw new Error(`以下订单没有仓库实收数据：${missing.map(item=>item.order_number).join("、")}`);
  const totalWeight=actuals.reduce((sum,item)=>sum+item.actual_weight_kg,0);
  const totalVolume=actuals.reduce((sum,item)=>sum+item.actual_volume_cbm,0);
  const method=input.method==="auto"?recommendAllocationMethod(input.chargeCode,totalWeight,totalVolume):input.method;
  const suggestions=allocateCost(actuals.map(item=>({orderId:item.order_id,actualWeightKg:item.actual_weight_kg,actualVolumeCbm:item.actual_volume_cbm})),input.totalAmount,method);
  const density=allocationDensity(totalWeight,totalVolume),allocationId=crypto.randomUUID();
  const statements:D1PreparedStatement[]=[
    db.prepare(`INSERT INTO transport_cost_allocations(id,organization_id,batch_id,charge_code,charge_name,counterparty_name,currency,exchange_rate,total_amount,allocation_method,total_actual_weight_kg,total_actual_volume_cbm,density_kg_per_cbm,density_result,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?,?,?)`).bind(allocationId,input.organizationId,input.batchId,input.chargeCode,input.chargeName,input.counterpartyName,input.currency.toUpperCase(),input.exchangeRate,input.totalAmount,method,totalWeight,totalVolume,density,density<300?"轻货：密度低于 300 KG/CBM":"重货：密度达到 300 KG/CBM",input.notes||null,input.userId,input.now,input.now),
    ...suggestions.map(line=>db.prepare(`INSERT INTO transport_cost_allocation_lines(id,organization_id,allocation_id,order_id,actual_weight_kg,actual_volume_cbm,suggested_ratio,suggested_amount,final_amount,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),input.organizationId,allocationId,line.orderId,line.actualWeightKg,line.actualVolumeCbm,line.ratio,line.amount,line.amount,input.now,input.now)),
  ];
  await db.batch(statements);
  return allocationId;
}

export async function updateCostAllocation(db:D1Database,input:{
  organizationId:string;allocationId:string;method:AllocationMethod;
  adjustments:{lineId:string;amount:number;reason:string}[];now:string;
}){
  const header=await db.prepare("SELECT id,batch_id,total_amount,status FROM transport_cost_allocations WHERE id=? AND organization_id=?").bind(input.allocationId,input.organizationId).first<{id:string;batch_id:string;total_amount:number;status:string}>();
  if(!header||header.status!=="draft")throw new Error("只有未确认的分摊草稿可以调整");
  await assertBatchCostAllocationOpen(db,input.organizationId,header.batch_id);
  const lines=await db.prepare("SELECT id,order_id,actual_weight_kg,actual_volume_cbm FROM transport_cost_allocation_lines WHERE organization_id=? AND allocation_id=? ORDER BY id").bind(input.organizationId,input.allocationId).all<{id:string;order_id:string;actual_weight_kg:number;actual_volume_cbm:number}>();
  if(lines.results.length!==input.adjustments.length)throw new Error("分摊明细不完整，请刷新页面后重试");
  const actuals=await loadBatchActuals(db,input.organizationId,header.batch_id);
  const missing=actuals.filter(item=>item.receipt_count===0);
  if(missing.length)throw new Error(`以下订单没有仓库实收数据：${missing.map(item=>item.order_number).join("、")}`);
  const actualByOrder=new Map(actuals.map(item=>[item.order_id,item]));
  const suggestions=allocateCost(lines.results.map(item=>{
    const actual=actualByOrder.get(item.order_id);
    if(!actual)throw new Error("分摊订单已不在当前配载批次，请刷新页面后重试");
    return{orderId:item.order_id,actualWeightKg:actual.actual_weight_kg,actualVolumeCbm:actual.actual_volume_cbm};
  }),header.total_amount,input.method);
  const suggestionByOrder=new Map(suggestions.map(item=>[item.orderId,item]));
  const adjustmentMap=new Map(input.adjustments.map(item=>[item.lineId,item]));
  const statements:D1PreparedStatement[]=[];
  let finalTotal=0;
  for(let index=0;index<lines.results.length;index++){
    const line=lines.results[index],actual=actualByOrder.get(line.order_id),suggestion=suggestionByOrder.get(line.order_id),adjustment=adjustmentMap.get(line.id);
    if(!actual||!suggestion)throw new Error("分摊订单实收数据不完整，请刷新页面后重试");
    if(!adjustment||!Number.isFinite(adjustment.amount)||adjustment.amount<0)throw new Error("分摊金额必须为不小于 0 的数字");
    if(Math.abs(adjustment.amount-suggestion.amount)>0.009&&!adjustment.reason.trim())throw new Error("修改系统建议金额时必须填写调整原因");
    finalTotal+=adjustment.amount;
    statements.push(db.prepare("UPDATE transport_cost_allocation_lines SET actual_weight_kg=?,actual_volume_cbm=?,suggested_ratio=?,suggested_amount=?,adjusted_amount=?,adjustment_reason=?,final_amount=?,updated_at=? WHERE id=? AND organization_id=? AND allocation_id=?").bind(actual.actual_weight_kg,actual.actual_volume_cbm,suggestion.ratio,suggestion.amount,Math.abs(adjustment.amount-suggestion.amount)>0.009?adjustment.amount:null,adjustment.reason.trim()||null,adjustment.amount,input.now,line.id,input.organizationId,input.allocationId));
  }
  if(Math.abs(finalTotal-header.total_amount)>0.009)throw new Error(`各订单分摊金额合计必须等于 ${header.total_amount.toFixed(2)}`);
  const totalWeight=actuals.reduce((sum,item)=>sum+item.actual_weight_kg,0);
  const totalVolume=actuals.reduce((sum,item)=>sum+item.actual_volume_cbm,0);
  const density=allocationDensity(totalWeight,totalVolume);
  statements.push(db.prepare("UPDATE transport_cost_allocations SET allocation_method=?,total_actual_weight_kg=?,total_actual_volume_cbm=?,density_kg_per_cbm=?,density_result=?,updated_at=? WHERE id=? AND organization_id=?").bind(input.method,totalWeight,totalVolume,density,density<300?"轻货：密度低于 300 KG/CBM":"重货：密度达到 300 KG/CBM",input.now,input.allocationId,input.organizationId));
  await db.batch(statements);
}

export async function confirmCostAllocation(db:D1Database,input:{organizationId:string;allocationId:string;userId:string;now:string}){
  const header=await db.prepare("SELECT * FROM transport_cost_allocations WHERE id=? AND organization_id=?").bind(input.allocationId,input.organizationId).first<CostAllocation>();
  if(!header||header.status!=="draft")throw new Error("该分摊草稿已确认或已失效");
  const gateOrders=await assertBatchCostAllocationOpen(db,input.organizationId,header.batch_id);
  const lines=await db.prepare("SELECT id,order_id,suggested_amount,final_amount,adjustment_reason FROM transport_cost_allocation_lines WHERE organization_id=? AND allocation_id=? ORDER BY id").bind(input.organizationId,input.allocationId).all<{id:string;order_id:string;suggested_amount:number;final_amount:number;adjustment_reason:string|null}>();
  if(!lines.results.length)throw new Error("分摊草稿没有订单明细");
  const activeOrderIds=new Set(gateOrders.map(item=>item.order_id));
  if(lines.results.some(line=>!activeOrderIds.has(line.order_id))||lines.results.length!==activeOrderIds.size)
    throw new Error("分摊草稿订单与当前配载单不一致，请作废草稿后重新生成");
  const total=lines.results.reduce((sum,line)=>sum+line.final_amount,0);
  if(Math.abs(total-header.total_amount)>0.009)throw new Error("分摊金额合计与费用总额不一致，请先调整");
  const missingReason=lines.results.some(line=>Math.abs(line.final_amount-line.suggested_amount)>0.009&&!line.adjustment_reason?.trim());
  if(missingReason)throw new Error("存在人工调整但未填写原因的订单");
  const statements:D1PreparedStatement[]=[];
  for(const line of lines.results){
    const expenseId=crypto.randomUUID();
    statements.push(
      db.prepare(`INSERT INTO business_expenses(id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id) VALUES(?,?,?,'payable','estimated',?,?,?,?,1,?,?,?,?,?,?,?,?,'loading_cost_allocation_line',?)`).bind(expenseId,input.organizationId,line.order_id,header.charge_code,header.charge_name,header.counterparty_name,header.currency,line.final_amount,line.final_amount,header.exchange_rate,line.final_amount*header.exchange_rate,`配载批次成本分摊；${header.notes||"无备注"}`,input.userId,input.now,input.now,line.id),
      db.prepare("UPDATE transport_cost_allocation_lines SET expense_id=?,updated_at=? WHERE id=? AND organization_id=?").bind(expenseId,input.now,line.id,input.organizationId),
      db.prepare(`INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,updated_at) VALUES(?,?,'payable',?) ON CONFLICT(order_id,direction) DO NOTHING`).bind(input.organizationId,line.order_id,input.now),
    );
  }
  statements.push(db.prepare("UPDATE transport_cost_allocations SET status='confirmed',confirmed_by_user_id=?,confirmed_at=?,updated_at=? WHERE id=? AND organization_id=? AND status='draft'").bind(input.userId,input.now,input.now,input.allocationId,input.organizationId));
  await db.batch(statements);
}

async function loadBatchActuals(db:D1Database,organizationId:string,batchId:string){
  const result=await db.prepare(`SELECT bo.order_id,o.order_number,c.name customer_name,COUNT(DISTINCT r.id) receipt_count,COALESCE(SUM(r.total_weight_kg),0) actual_weight_kg,COALESCE(SUM(r.total_volume_cbm),0) actual_volume_cbm
    FROM transport_batch_orders bo
    JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
    JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
    LEFT JOIN shipments s ON s.order_id=o.id AND s.organization_id=o.organization_id
    LEFT JOIN warehouse_receipts r
      ON r.shipment_id=s.id AND r.organization_id=o.organization_id
     AND r.warehouse_id=b.warehouse_id AND r.status='completed'
    WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    GROUP BY bo.order_id,o.order_number,c.name ORDER BY bo.sequence_no`).bind(organizationId,batchId).all<ActualOrder>();
  if(!result.results.length)throw new Error("配载批次没有有效订单");
  return result.results;
}
