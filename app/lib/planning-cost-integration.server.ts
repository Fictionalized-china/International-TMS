/** The configured allocation and child costs commit with the batch, never a second write. */
export function plannedCostIntegrationStatements(db:D1Database,input:{organizationId:string;allocationId:string;actorUserId:string;currency:string;exchangeRate:number;counterparty:string;now:string;lines:{id:string;orderId:string;amount:number}[]}) {
  const statements:D1PreparedStatement[]=[];
  for(const line of input.lines){
    const expenseId=crypto.randomUUID();
    statements.push(db.prepare(`INSERT INTO settlement_commit_guards(id,valid,created_at)
      SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM eligible_planned_cost_orders WHERE organization_id=? AND order_id=? AND allocation_id=?) THEN 1 ELSE NULL END,?`).bind(expenseId,input.organizationId,line.orderId,input.allocationId,input.now));
    statements.push(db.prepare(`INSERT INTO business_expenses(id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id)
      VALUES(?,?,?,'payable','estimated','OVERSEAS_TRANSPORT','境外运输费',?,?,1,?,?,?,?,?,?,?,?, 'loading_cost_allocation_line',?)`).bind(expenseId,input.organizationId,line.orderId,input.counterparty,input.currency,line.amount,line.amount,input.exchangeRate,line.amount*input.exchangeRate,'配载生成自动分摊；原费用保留，按分摊来源追溯',input.actorUserId,input.now,input.now,line.id));
    statements.push(db.prepare('UPDATE transport_cost_allocation_lines SET expense_id=? WHERE id=? AND organization_id=? AND allocation_id=?').bind(expenseId,line.id,input.organizationId,input.allocationId));
  }
  statements.push(db.prepare("UPDATE transport_cost_allocations SET status='confirmed',confirmed_by_user_id=?,confirmed_at=? WHERE id=? AND organization_id=? AND status='draft'").bind(input.actorUserId,input.now,input.allocationId,input.organizationId));
  return statements;
}
