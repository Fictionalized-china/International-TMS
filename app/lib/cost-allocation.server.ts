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
  const header=await db.prepare("SELECT id,total_amount,status FROM transport_cost_allocations WHERE id=? AND organization_id=?").bind(input.allocationId,input.organizationId).first<{id:string;total_amount:number;status:string}>();
  if(!header||header.status!=="draft")throw new Error("只有未确认的分摊草稿可以调整");
  const lines=await db.prepare("SELECT id,order_id,actual_weight_kg,actual_volume_cbm FROM transport_cost_allocation_lines WHERE organization_id=? AND allocation_id=? ORDER BY id").bind(input.organizationId,input.allocationId).all<{id:string;order_id:string;actual_weight_kg:number;actual_volume_cbm:number}>();
  if(lines.results.length!==input.adjustments.length)throw new Error("分摊明细不完整，请刷新页面后重试");
  const suggestions=allocateCost(lines.results.map(item=>({orderId:item.order_id,actualWeightKg:item.actual_weight_kg,actualVolumeCbm:item.actual_volume_cbm})),header.total_amount,input.method);
  const adjustmentMap=new Map(input.adjustments.map(item=>[item.lineId,item]));
  const statements:D1PreparedStatement[]=[];
  let finalTotal=0;
  for(let index=0;index<lines.results.length;index++){
    const line=lines.results[index],suggestion=suggestions[index],adjustment=adjustmentMap.get(line.id);
    if(!adjustment||!Number.isFinite(adjustment.amount)||adjustment.amount<0)throw new Error("分摊金额必须为不小于 0 的数字");
    if(Math.abs(adjustment.amount-suggestion.amount)>0.009&&!adjustment.reason.trim())throw new Error("修改系统建议金额时必须填写调整原因");
    finalTotal+=adjustment.amount;
    statements.push(db.prepare("UPDATE transport_cost_allocation_lines SET suggested_ratio=?,suggested_amount=?,adjusted_amount=?,adjustment_reason=?,final_amount=?,updated_at=? WHERE id=? AND organization_id=? AND allocation_id=?").bind(suggestion.ratio,suggestion.amount,Math.abs(adjustment.amount-suggestion.amount)>0.009?adjustment.amount:null,adjustment.reason.trim()||null,adjustment.amount,input.now,line.id,input.organizationId,input.allocationId));
  }
  if(Math.abs(finalTotal-header.total_amount)>0.009)throw new Error(`各订单分摊金额合计必须等于 ${header.total_amount.toFixed(2)}`);
  statements.push(db.prepare("UPDATE transport_cost_allocations SET allocation_method=?,updated_at=? WHERE id=? AND organization_id=?").bind(input.method,input.now,input.allocationId,input.organizationId));
  await db.batch(statements);
}

export async function confirmCostAllocation(db:D1Database,input:{organizationId:string;allocationId:string;userId:string;now:string}){
  const header=await db.prepare("SELECT * FROM transport_cost_allocations WHERE id=? AND organization_id=?").bind(input.allocationId,input.organizationId).first<CostAllocation>();
  if(!header||header.status!=="draft")throw new Error("该分摊草稿已确认或已失效");
  const lines=await db.prepare("SELECT id,order_id,suggested_amount,final_amount,adjustment_reason FROM transport_cost_allocation_lines WHERE organization_id=? AND allocation_id=? ORDER BY id").bind(input.organizationId,input.allocationId).all<{id:string;order_id:string;suggested_amount:number;final_amount:number;adjustment_reason:string|null}>();
  if(!lines.results.length)throw new Error("分摊草稿没有订单明细");
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
    FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id
    LEFT JOIN shipments s ON s.order_id=o.id LEFT JOIN warehouse_receipts r ON r.shipment_id=s.id AND r.status='completed'
    WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    GROUP BY bo.order_id,o.order_number,c.name ORDER BY bo.sequence_no`).bind(organizationId,batchId).all<ActualOrder>();
  if(!result.results.length)throw new Error("配载批次没有有效订单");
  return result.results;
}
