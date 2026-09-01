import{allocateToOutstanding,settlementDocumentNumber}from"./settlement";
import{refreshOrderCompletionStatus}from"./order-review.server";
import{chunkD1Rows,chunkD1Values,d1Placeholders}from"./d1-bindings";

export type SettlementExpense={
  id:string;order_id:string;order_number:string;customer_name:string;direction:"receivable"|"payable";
  charge_name:string;counterparty_name:string;currency:string;amount:number;stage:string;
  invoiced_amount:number;settled_amount:number;outbound_ready:number;
};

export type ReconciliationRow={
  id:string;document_number:string;direction:"receivable"|"payable";counterparty_name:string;
  settlement_entity:string;currency:string;total_amount:number;status:string;notes:string|null;
  confirmed_at:string|null;created_at:string;expense_count:number;orders:string|null;order_refs:string|null;
  invoiced_amount:number;settled_amount:number;
};

export type InvoiceRecordRow={
  id:string;record_number:string;reconciliation_id:string;direction:string;counterparty_name:string;
  invoice_company:string;invoice_type:string;invoice_number:string;invoice_date:string;currency:string;
  amount:number;status:string;created_at:string;
};

export type CashTransactionRow={
  id:string;transaction_number:string;direction:"receipt"|"payment";counterparty_name:string;
  currency:string;amount:number;occurred_on:string;settlement_entity:string;account_name:string;
  status:string;allocated_amount:number;created_at:string;
};

export async function loadSettlementWorkbench(db:D1Database,organizationId:string){
  const [eligible,reconciliations,invoices,cash]=await Promise.all([
    db.prepare(`SELECT e.id,e.order_id,o.order_number,c.name customer_name,e.direction,e.charge_name,CASE WHEN e.direction='receivable' THEN c.name ELSE COALESCE(NULLIF(TRIM(e.counterparty_name),''),'未指定供应商') END counterparty_name,e.currency,e.amount,e.stage,
      COALESCE((SELECT SUM(a.amount) FROM settlement_invoice_allocations a JOIN settlement_invoice_records i ON i.id=a.invoice_record_id AND i.status!='void' WHERE a.expense_id=e.id),0) invoiced_amount,
      COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.status!='void' WHERE a.expense_id=e.id),0) settled_amount,
      CASE WHEN EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed')) THEN 1 ELSE 0 END outbound_ready
      FROM business_expenses e JOIN transport_orders o ON o.id=e.order_id JOIN customers c ON c.id=o.customer_id
      WHERE e.organization_id=? AND e.stage='confirmed' AND e.amount>0 AND NOT EXISTS(SELECT 1 FROM settlement_reconciliation_lines l JOIN settlement_reconciliations r ON r.id=l.reconciliation_id WHERE l.expense_id=e.id AND r.status!='withdrawn')
      AND (e.direction='payable' OR EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed')))
      ORDER BY e.direction,c.name,e.currency,o.order_number,e.created_at`).bind(organizationId).all<SettlementExpense>(),
    db.prepare(`SELECT r.id,r.document_number,r.direction,r.counterparty_name,r.settlement_entity,r.currency,r.total_amount,r.status,r.notes,r.confirmed_at,r.created_at,COUNT(DISTINCT l.expense_id) expense_count,GROUP_CONCAT(DISTINCT o.order_number) orders,GROUP_CONCAT(DISTINCT o.id||'|'||o.order_number) order_refs,
      COALESCE((SELECT SUM(i.amount) FROM settlement_invoice_records i WHERE i.reconciliation_id=r.id AND i.status!='void'),0) invoiced_amount,
      COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.status!='void' WHERE a.reconciliation_id=r.id),0) settled_amount
      FROM settlement_reconciliations r JOIN settlement_reconciliation_lines l ON l.reconciliation_id=r.id JOIN business_expenses e ON e.id=l.expense_id LEFT JOIN transport_orders o ON o.id=e.order_id
      WHERE r.organization_id=? AND r.status!='withdrawn' GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`).bind(organizationId).all<ReconciliationRow>(),
    db.prepare(`SELECT id,record_number,reconciliation_id,direction,counterparty_name,invoice_company,invoice_type,invoice_number,invoice_date,currency,amount,status,created_at FROM settlement_invoice_records WHERE organization_id=? AND status!='void' ORDER BY created_at DESC LIMIT 100`).bind(organizationId).all<InvoiceRecordRow>(),
    db.prepare(`SELECT t.id,t.transaction_number,t.direction,t.counterparty_name,t.currency,t.amount,t.occurred_on,t.settlement_entity,t.account_name,t.status,t.created_at,COALESCE(SUM(a.amount),0) allocated_amount FROM settlement_cash_transactions t LEFT JOIN settlement_cash_allocations a ON a.cash_transaction_id=t.id WHERE t.organization_id=? AND t.status!='void' GROUP BY t.id ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 100`).bind(organizationId).all<CashTransactionRow>(),
  ]);
  return{eligibleExpenses:eligible.results,reconciliations:reconciliations.results,invoices:invoices.results,cashTransactions:cash.results};
}

export async function createReconciliation(db:D1Database,input:{organizationId:string;expenseIds:string[];direction:"receivable"|"payable";notes?:string;userId:string;now:string}){
  const ids=[...new Set(input.expenseIds)].slice(0,100);
  if(!ids.length)throw new Error("请至少勾选一条已确认费用");
  type Candidate={id:string;order_id:string;direction:string;stage:string;currency:string;amount:number;counterparty_name:string|null;customer_id:string;customer_name:string;outbound_ready:number;already_linked:number};
  const loaded:Candidate[]=[];
  for(const chunk of chunkD1Values(ids,1)){
    const result=await db.prepare(`SELECT e.id,e.order_id,e.direction,e.stage,e.currency,e.amount,e.counterparty_name,o.customer_id,c.name customer_name,
      CASE WHEN EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed')) THEN 1 ELSE 0 END outbound_ready,
      CASE WHEN EXISTS(SELECT 1 FROM settlement_reconciliation_lines l JOIN settlement_reconciliations r ON r.id=l.reconciliation_id WHERE l.expense_id=e.id AND r.status!='withdrawn') THEN 1 ELSE 0 END already_linked
      FROM business_expenses e JOIN transport_orders o ON o.id=e.order_id JOIN customers c ON c.id=o.customer_id WHERE e.organization_id=? AND e.id IN (${d1Placeholders(chunk.length)})`).bind(input.organizationId,...chunk).all<Candidate>();
    loaded.push(...result.results);
  }
  const loadedById=new Map(loaded.map(row=>[row.id,row])),rows=ids.map(id=>loadedById.get(id)).filter((row):row is Candidate=>Boolean(row));
  if(rows.length!==ids.length)throw new Error("部分费用不存在，请刷新页面后重试");
  if(rows.some(row=>row.direction!==input.direction||row.stage!=="confirmed"))throw new Error("只能选择同方向的已确认费用");
  if(rows.some(row=>row.already_linked))throw new Error("部分费用已加入其他有效对账单");
  if(input.direction==="receivable"&&rows.some(row=>!row.outbound_ready))throw new Error("客户应收对账只能在订单进入出境运输后发起");
  const currency=rows[0].currency;
  if(rows.some(row=>row.currency!==currency))throw new Error("一张对账单只能包含同一币种");
  const customerId=input.direction==="receivable"?rows[0].customer_id:null;
  const counterparty=input.direction==="receivable"?rows[0].customer_name:(rows[0].counterparty_name||"").trim();
  if(!counterparty)throw new Error("应付费用缺少往来单位，不能发起对账");
  if(input.direction==="receivable"&&rows.some(row=>row.customer_id!==customerId))throw new Error("客户应收对账不能跨客户合并");
  if(input.direction==="payable"&&rows.some(row=>(row.counterparty_name||"").trim()!==counterparty))throw new Error("供应商应付对账不能跨往来单位合并");
  if(rows.some(row=>!Number.isFinite(row.amount)||row.amount<=0))throw new Error("所选费用中存在金额为 0 的记录，请先完善费用金额再发起对账");
  const org=await db.prepare("SELECT name FROM organizations WHERE id=?").bind(input.organizationId).first<{name:string}>();
  if(!org)throw new Error("组织信息无效");
  const id=crypto.randomUUID(),number=settlementDocumentNumber(input.direction==="receivable"?"REC":"PAY",new Date(input.now)),total=rows.reduce((sum,row)=>sum+row.amount,0);
  if(!Number.isFinite(total)||total<=0)throw new Error("所选费用合计必须大于 0，请先完善费用金额再发起对账");
  const lineStatements=chunkD1Rows(rows,6).map(chunk=>db.prepare(`INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES ${chunk.map(()=>"(?,?,?,?,?,?)").join(",")}`).bind(...chunk.flatMap(row=>[crypto.randomUUID(),input.organizationId,id,row.id,row.amount,input.now])));
  await db.batch([
    db.prepare(`INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,customer_id,settlement_entity,currency,total_amount,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`).bind(id,input.organizationId,number,input.direction,counterparty,customerId,org.name,currency,total,input.notes||null,input.userId,input.now,input.now),
    ...lineStatements,
  ]);
  return{id,number};
}

export async function confirmReconciliation(db:D1Database,input:{organizationId:string;id:string;userId:string;now:string}){
  const row=await db.prepare("SELECT status,direction FROM settlement_reconciliations WHERE id=? AND organization_id=?").bind(input.id,input.organizationId).first<{status:string;direction:string}>();
  if(!row||row.status!=="draft")throw new Error("只有草稿对账单可以确认");
  const statements=[
    db.prepare("UPDATE settlement_reconciliations SET status='confirmed',confirmed_by_user_id=?,confirmed_at=?,updated_at=? WHERE id=? AND organization_id=? AND status='draft'").bind(input.userId,input.now,input.now,input.id,input.organizationId),
    db.prepare("UPDATE business_expenses SET stage='reconciled',updated_at=? WHERE organization_id=? AND stage='confirmed' AND id IN (SELECT expense_id FROM settlement_reconciliation_lines WHERE reconciliation_id=?)").bind(input.now,input.organizationId,input.id),
  ];
  if(row.direction==="receivable")statements.push(db.prepare(`UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE organization_id=? AND task_type='start_receivable_reconciliation' AND status IN ('pending','in_progress') AND order_id IN (SELECT e.order_id FROM settlement_reconciliation_lines l JOIN business_expenses e ON e.id=l.expense_id WHERE l.reconciliation_id=?)`).bind(input.now,input.now,input.organizationId,input.id));
  await db.batch(statements);
}

export async function recordSettlementInvoice(db:D1Database,input:{organizationId:string;reconciliationId:string;amount:number;invoiceCompany:string;invoiceType:string;invoiceNumber:string;invoiceCode?:string;invoiceDate:string;taxRate:number;titleName:string;taxNumber?:string;addressPhone?:string;bankAccount?:string;exchangeRate:number;attachmentReference?:string;notes?:string;userId:string;now:string}){
  const reconciliation=await db.prepare("SELECT * FROM settlement_reconciliations WHERE id=? AND organization_id=? AND status='confirmed'").bind(input.reconciliationId,input.organizationId).first<ReconciliationRow>();
  if(!reconciliation)throw new Error("只能从已确认对账单登记发票");
  if(!input.invoiceCompany||!input.invoiceType||!input.invoiceNumber||!input.invoiceDate||!input.titleName)throw new Error("请填写开票/收票公司、类别、号码、日期和抬头");
  if(!Number.isFinite(input.taxRate)||input.taxRate<0||!Number.isFinite(input.exchangeRate)||input.exchangeRate<=0)throw new Error("税率或汇率无效");
  const lines=await loadReconciliationOutstanding(db,input.organizationId,input.reconciliationId,"invoice");
  const allocations=allocateToOutstanding(lines.map(line=>({id:line.expense_id,outstanding:line.outstanding})),input.amount);
  const id=crypto.randomUUID(),recordNumber=settlementDocumentNumber("TAX",new Date(input.now));
  const allocationStatements=chunkD1Rows(allocations,6).map(chunk=>db.prepare(`INSERT INTO settlement_invoice_allocations(id,organization_id,invoice_record_id,expense_id,amount,created_at) VALUES ${chunk.map(()=>"(?,?,?,?,?,?)").join(",")}`).bind(...chunk.flatMap(item=>[crypto.randomUUID(),input.organizationId,id,item.id,item.amount,input.now])));
  await db.batch([
    db.prepare(`INSERT INTO settlement_invoice_records(id,organization_id,record_number,reconciliation_id,direction,counterparty_name,invoice_company,invoice_type,invoice_number,invoice_code,invoice_date,tax_rate,title_name,tax_number,address_phone,bank_account,currency,amount,exchange_rate,attachment_reference,notes,status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'recorded',?,?)`).bind(id,input.organizationId,recordNumber,input.reconciliationId,reconciliation.direction,reconciliation.counterparty_name,input.invoiceCompany,input.invoiceType,input.invoiceNumber,input.invoiceCode||null,input.invoiceDate,input.taxRate,input.titleName,input.taxNumber||null,input.addressPhone||null,input.bankAccount||null,reconciliation.currency,input.amount,input.exchangeRate,input.attachmentReference||null,input.notes||null,input.userId,input.now),
    ...allocationStatements,
  ]);
  await refreshExpenseStages(db,input.organizationId,allocations.map(item=>item.id),input.now);
  return{id,recordNumber};
}

export async function recordCashTransaction(db:D1Database,input:{organizationId:string;direction:"receipt"|"payment";counterpartyName:string;currency:string;amount:number;occurredOn:string;settlementEntity:string;accountName:string;handledByUserId:string;evidenceReference?:string;notes?:string;userId:string;now:string}){
  if(!input.counterpartyName||!input.currency||!input.occurredOn||!input.settlementEntity||!input.accountName||!input.handledByUserId)throw new Error("请完整填写往来单位、币种、日期、所属公司、账户和经办人");
  if(!Number.isFinite(input.amount)||input.amount<=0)throw new Error("收付款金额必须大于 0");
  const user=await db.prepare("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.organization_id=? AND m.status='active' AND u.status='active'").bind(input.handledByUserId,input.organizationId).first();
  if(!user)throw new Error("经办人无效");
  const id=crypto.randomUUID(),number=settlementDocumentNumber("CASH",new Date(input.now));
  await db.prepare(`INSERT INTO settlement_cash_transactions(id,organization_id,transaction_number,direction,counterparty_name,currency,amount,occurred_on,settlement_entity,account_name,handled_by_user_id,evidence_reference,notes,status,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'unallocated',?,?,?)`).bind(id,input.organizationId,number,input.direction,input.counterpartyName,input.currency.toUpperCase(),input.amount,input.occurredOn,input.settlementEntity,input.accountName,input.handledByUserId,input.evidenceReference||null,input.notes||null,input.userId,input.now,input.now).run();
  return{id,number};
}

export async function allocateCashTransaction(db:D1Database,input:{organizationId:string;transactionId:string;reconciliationId:string;amount:number;userId:string;now:string}){
  const [cash,reconciliation]=await Promise.all([
    db.prepare(`SELECT t.*,t.amount-COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a WHERE a.cash_transaction_id=t.id),0) remaining FROM settlement_cash_transactions t WHERE t.id=? AND t.organization_id=? AND t.status!='void'`).bind(input.transactionId,input.organizationId).first<CashTransactionRow&{remaining:number}>(),
    db.prepare("SELECT * FROM settlement_reconciliations WHERE id=? AND organization_id=? AND status='confirmed'").bind(input.reconciliationId,input.organizationId).first<ReconciliationRow>(),
  ]);
  if(!cash||!reconciliation)throw new Error("收付款流水或对账单无效");
  const expectedDirection=reconciliation.direction==="receivable"?"receipt":"payment";
  if(cash.direction!==expectedDirection)throw new Error("收付款方向与对账单方向不一致");
  if(cash.counterparty_name!==reconciliation.counterparty_name||cash.currency!==reconciliation.currency)throw new Error("只能核销同一往来单位、同一币种的费用");
  if(input.amount-cash.remaining>0.009)throw new Error("核销金额超过流水未分配余额");
  const lines=await loadReconciliationOutstanding(db,input.organizationId,input.reconciliationId,"cash");
  const allocations=allocateToOutstanding(lines.map(line=>({id:line.expense_id,outstanding:line.outstanding})),input.amount);
  const allocationStatements=chunkD1Rows(allocations,8).map(chunk=>db.prepare(`INSERT INTO settlement_cash_allocations(id,organization_id,cash_transaction_id,reconciliation_id,expense_id,amount,created_by_user_id,created_at) VALUES ${chunk.map(()=>"(?,?,?,?,?,?,?,?)").join(",")}`).bind(...chunk.flatMap(item=>[crypto.randomUUID(),input.organizationId,input.transactionId,input.reconciliationId,item.id,item.amount,input.userId,input.now])));
  await db.batch(allocationStatements);
  const allocated=await db.prepare("SELECT COALESCE(SUM(amount),0) total FROM settlement_cash_allocations WHERE cash_transaction_id=?").bind(input.transactionId).first<{total:number}>();
  const status=(allocated?.total??0)>=cash.amount-0.009?"allocated":"partially_allocated";
  await db.prepare("UPDATE settlement_cash_transactions SET status=?,updated_at=? WHERE id=? AND organization_id=?").bind(status,input.now,input.transactionId,input.organizationId).run();
  await refreshExpenseStages(db,input.organizationId,allocations.map(item=>item.id),input.now);
  const affectedOrderIds:string[]=[];
  for(const allocationChunk of chunkD1Values(allocations,1)){
    const affectedOrders=await db.prepare(`SELECT DISTINCT order_id FROM business_expenses WHERE organization_id=? AND id IN (${d1Placeholders(allocationChunk.length)}) AND order_id IS NOT NULL`).bind(input.organizationId,...allocationChunk.map(item=>item.id)).all<{order_id:string}>();
    affectedOrderIds.push(...affectedOrders.results.map(row=>row.order_id));
  }
  await refreshOrderCompletionStatus(db,input.organizationId,[...new Set(affectedOrderIds)],input.now);
}

async function loadReconciliationOutstanding(db:D1Database,organizationId:string,reconciliationId:string,type:"invoice"|"cash"){
  const allocationTable=type==="invoice"?"settlement_invoice_allocations":"settlement_cash_allocations";
  const statusJoin=type==="invoice"?"JOIN settlement_invoice_records h ON h.id=a.invoice_record_id AND h.status!='void'":"JOIN settlement_cash_transactions h ON h.id=a.cash_transaction_id AND h.status!='void'";
  return (await db.prepare(`SELECT l.expense_id,l.amount-COALESCE((SELECT SUM(a.amount) FROM ${allocationTable} a ${statusJoin} WHERE a.expense_id=l.expense_id),0) outstanding FROM settlement_reconciliation_lines l WHERE l.organization_id=? AND l.reconciliation_id=? ORDER BY l.created_at`).bind(organizationId,reconciliationId).all<{expense_id:string;outstanding:number}>()).results;
}

async function refreshExpenseStages(db:D1Database,organizationId:string,expenseIds:string[],now:string){
  for(const chunk of chunkD1Values([...new Set(expenseIds)],2)){
    await db.prepare(`UPDATE business_expenses AS e SET stage=CASE
      WHEN COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.status!='void' WHERE a.expense_id=e.id),0)>=e.amount-0.009 THEN 'settled'
      WHEN COALESCE((SELECT SUM(a.amount) FROM settlement_invoice_allocations a JOIN settlement_invoice_records i ON i.id=a.invoice_record_id AND i.status!='void' WHERE a.expense_id=e.id),0)>=e.amount-0.009 THEN 'invoiced'
      ELSE 'reconciled' END,updated_at=?
      WHERE e.organization_id=? AND e.id IN (${d1Placeholders(chunk.length)})`).bind(now,organizationId,...chunk).run();
  }
}
