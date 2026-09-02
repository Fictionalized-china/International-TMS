import{env}from"cloudflare:workers";
import{Form,Link,useNavigation}from"react-router";
import type{Route}from"./+types/admin.billing";
import{requireSessionUser}from"../lib/auth.server";
import{writeAudit}from"../lib/audit.server";
import{valueOf}from"../lib/validation";
import{allocateCashTransaction,confirmReconciliation,createReconciliation,loadSettlementWorkbench,recordCashTransaction,recordSettlementInvoice,type ReconciliationRow,type SettlementExpense}from"../lib/settlement-workbench.server";
import{OrderNumberLink,OrderNumberLinkList}from"../components/EntityNumberLink";

type UserOption={id:string;display_name:string};
type LegacyInvoice={id:string;invoice_number:string;customer_name:string;currency:string;total_amount:number;paid_amount:number;status:string;created_at:string};

export async function loader({request}:Route.LoaderArgs){
  const current=await requireSessionUser(request,"billing.view");
  if(!current.permissions.includes("billing.sensitive.view"))throw new Response("没有权限查看应收、应付和利润数据",{status:403});
  const [workbench,organization,users,legacyInvoices]=await Promise.all([
    loadSettlementWorkbench(env.DB,current.organizationId),
    env.DB.prepare("SELECT name FROM organizations WHERE id=?").bind(current.organizationId).first<{name:string}>(),
    env.DB.prepare("SELECT u.id,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY u.display_name").bind(current.organizationId).all<UserOption>(),
    env.DB.prepare("SELECT i.id,i.invoice_number,c.name customer_name,i.currency,i.total_amount,i.paid_amount,i.status,i.created_at FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.organization_id=? ORDER BY i.created_at DESC LIMIT 50").bind(current.organizationId).all<LegacyInvoice>(),
  ]);
  return{current,...workbench,organizationName:organization?.name||"当前组织",users:users.results,legacyInvoices:legacyInvoices.results};
}

export async function action({request}:Route.ActionArgs){
  const current=await requireSessionUser(request,"billing.view"),form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(!current.permissions.includes("billing.sensitive.view"))throw new Response("没有权限查看或处理敏感费用",{status:403});
  const cashIntent=intent==="record_cash"||intent==="allocate_cash";
  if(cashIntent&&!current.permissions.includes("billing.cash.manage"))throw new Response("没有收付款与核销权限",{status:403});
  if(!cashIntent&&!current.permissions.includes("billing.manage"))throw new Response("没有对账与发票管理权限",{status:403});
  try{
    if(intent==="create_reconciliation"){
      const direction=valueOf(form,"direction");
      if(direction!=="receivable"&&direction!=="payable")return{formError:"对账方向无效"};
      const result=await createReconciliation(env.DB,{organizationId:current.organizationId,expenseIds:form.getAll("expenseId").map(String),direction,notes:valueOf(form,"notes"),userId:current.userId,now});
      await audit(request,current,"settlement.reconciliation.create","settlement_reconciliation",result.id,{number:result.number,direction});
      return{success:`对账单 ${result.number} 已生成草稿，请复核后确认`};
    }
    if(intent==="confirm_reconciliation"){
      const id=valueOf(form,"id");
      await confirmReconciliation(env.DB,{organizationId:current.organizationId,id,userId:current.userId,now});
      await audit(request,current,"settlement.reconciliation.confirm","settlement_reconciliation",id,{});
      return{success:"对账单已确认；现在可以登记发票和匹配收付款流水"};
    }
    if(intent==="record_invoice"){
      const reconciliationId=valueOf(form,"reconciliationId");
      const result=await recordSettlementInvoice(env.DB,{organizationId:current.organizationId,reconciliationId,amount:positive(form,"amount"),invoiceCompany:valueOf(form,"invoiceCompany"),invoiceType:valueOf(form,"invoiceType"),invoiceNumber:valueOf(form,"invoiceNumber"),invoiceCode:valueOf(form,"invoiceCode"),invoiceDate:valueOf(form,"invoiceDate"),taxRate:nonNegative(form,"taxRate"),titleName:valueOf(form,"titleName"),taxNumber:valueOf(form,"taxNumber"),addressPhone:valueOf(form,"addressPhone"),bankAccount:valueOf(form,"bankAccount"),exchangeRate:positive(form,"exchangeRate",1),attachmentReference:valueOf(form,"attachmentReference"),notes:valueOf(form,"invoiceNotes"),userId:current.userId,now});
      await audit(request,current,"settlement.invoice.record","settlement_invoice_record",result.id,{recordNumber:result.recordNumber,reconciliationId});
      return{success:`发票记录 ${result.recordNumber} 已保存`};
    }
    if(intent==="record_cash"){
      const direction=valueOf(form,"direction");
      if(direction!=="receipt"&&direction!=="payment")return{formError:"收付款方向无效"};
      const result=await recordCashTransaction(env.DB,{organizationId:current.organizationId,direction,counterpartyName:valueOf(form,"counterpartyName"),currency:valueOf(form,"currency"),amount:positive(form,"amount"),occurredOn:valueOf(form,"occurredOn"),settlementEntity:valueOf(form,"settlementEntity"),accountName:valueOf(form,"accountName"),handledByUserId:valueOf(form,"handledByUserId"),evidenceReference:valueOf(form,"evidenceReference"),notes:valueOf(form,"cashNotes"),userId:current.userId,now});
      await audit(request,current,"settlement.cash.record","settlement_cash_transaction",result.id,{number:result.number,direction});
      return{success:`流水 ${result.number} 已登记；可继续匹配对账单进行核销`};
    }
    if(intent==="allocate_cash"){
      const transactionId=valueOf(form,"transactionId"),reconciliationId=valueOf(form,"reconciliationId");
      await allocateCashTransaction(env.DB,{organizationId:current.organizationId,transactionId,reconciliationId,amount:positive(form,"amount"),userId:current.userId,now});
      await audit(request,current,"settlement.cash.allocate","settlement_cash_transaction",transactionId,{reconciliationId});
      return{success:"收付款流水已核销到费用；未分配余额和费用未核销余额已同步更新"};
    }
    return{formError:"操作无效"};
  }catch(error){return{formError:error instanceof Error?error.message:"操作失败，请稍后重试"}}
}

export default function Billing({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",manage=loaderData.current.permissions.includes("billing.manage"),cashManage=loaderData.current.permissions.includes("billing.cash.manage"),eligibleReceivable=loaderData.eligibleExpenses.filter(item=>item.direction==="receivable"),eligiblePayable=loaderData.eligibleExpenses.filter(item=>item.direction==="payable");
  const outstanding=loaderData.reconciliations.reduce((sum,item)=>sum+Math.max(0,item.total_amount-item.settled_amount),0);
  return <><header className="page-header"><div><p className="eyebrow">FINANCE SETTLEMENT</p><h1>费用结算</h1><p>一条主线完成费用对账、发票、收付款和核销；应收与应付独立推进。</p></div><span className="status-pill">未核销 {outstanding.toFixed(2)}</span></header>{(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>{actionData.formError??actionData.success}</div>}
    <section className="panel settlement-summary-table"><div className="table-wrap"><table><thead><tr><th>待对账费用</th><th>对账单</th><th>发票记录</th><th>收付款流水</th></tr></thead><tbody><tr><td><strong>{loaderData.eligibleExpenses.length}</strong><small>仅已确认费用</small></td><td><strong>{loaderData.reconciliations.length}</strong><small>应收 / 应付</small></td><td><strong>{loaderData.invoices.length}</strong><small>销项 / 进项</small></td><td><strong>{loaderData.cashTransactions.length}</strong><small>可分次核销</small></td></tr></tbody></table></div></section>
    <section className="panel settlement-step"><div className="panel-header"><div><h2>1. 从已确认费用发起对账</h2><p>应收只可选择同客户、同币种且已出境的费用；应付只可选择同供应商、同币种的费用。</p></div></div>{manage?<div className="settlement-two-column"><ExpenseSelection direction="receivable" expenses={eligibleReceivable} busy={busy}/><ExpenseSelection direction="payable" expenses={eligiblePayable} busy={busy}/></div>:<p className="muted">当前账号只有查看权限。</p>}</section>
    <section className="panel settlement-step"><div className="panel-header"><div><h2>2. 对账单复核与后续办理</h2><p>确认后可登记部分发票、登记银行流水，并将同往来单位同币种的流水分次核销。</p></div></div><div className="reconciliation-list">{loaderData.reconciliations.map(row=><ReconciliationSheet key={row.id} row={row} manage={manage} cashManage={cashManage} busy={busy} cash={loaderData.cashTransactions}/>)}</div>{!loaderData.reconciliations.length&&<p className="empty-state">暂无对账单。</p>}</section>
    {cashManage&&<section className="panel settlement-step"><div className="panel-header"><div><h2>3. 独立登记收付款流水</h2><p>先登记真实银行/现金流水，之后再匹配对账单；一笔流水可以分多次核销。</p></div></div><Form method="post" className="form-grid compact settlement-cash-form"><input type="hidden" name="intent" value="record_cash"/><Sel name="direction" label="方向" items={[["receipt","客户收款"],["payment","供应商付款"]]}/><Text name="counterpartyName" label="往来单位" required/><Text name="currency" label="币种" required defaultValue="CNY"/><Num name="amount" label="金额" required/><label className="field"><span>收 / 付款日期</span><input name="occurredOn" type="date" required/></label><Text name="settlementEntity" label="所属公司" required defaultValue={loaderData.organizationName}/><Text name="accountName" label="银行 / 现金账户" required/><Sel name="handledByUserId" label="经办人" items={loaderData.users.map(item=>[item.id,item.display_name])}/><Text name="evidenceReference" label="凭证附件 / 编号"/><label className="field settlement-cash-notes"><span>备注</span><textarea name="cashNotes" rows={2}/></label><button className="primary" disabled={busy}>登记收付款流水</button></Form></section>}
    <section className="panel settlement-step"><div className="panel-header"><div><h2>4. 收付款流水</h2><p>清楚区分流水总额、已分配金额和未分配余额。</p></div></div><div className="table-wrap"><table><thead><tr><th>流水号 / 日期</th><th>方向</th><th>往来单位</th><th>金额</th><th>已分配 / 未分配</th><th>账户 / 公司</th><th>状态</th></tr></thead><tbody>{loaderData.cashTransactions.map(row=><tr key={row.id}><td><strong>{row.transaction_number}</strong><small>{row.occurred_on}</small></td><td>{row.direction==="receipt"?"收款":"付款"}</td><td>{row.counterparty_name}</td><td>{row.currency} {row.amount.toFixed(2)}</td><td>{row.allocated_amount.toFixed(2)} / {(row.amount-row.allocated_amount).toFixed(2)}</td><td>{row.account_name}<small>{row.settlement_entity}</small></td><td><span className="status-pill">{cashStatus(row.status)}</span></td></tr>)}</tbody></table></div>{!loaderData.cashTransactions.length&&<p className="empty-state">暂无收付款流水。</p>}</section>
    <section className="panel settlement-step"><div className="panel-header"><div><h2>5. 发票记录</h2><p>销项和进项均来源于已确认对账单，支持部分开票/收票。</p></div></div><div className="table-wrap"><table><thead><tr><th>内部记录号</th><th>发票号码</th><th>方向 / 类别</th><th>往来单位</th><th>开票/收票公司</th><th>金额</th><th>日期</th></tr></thead><tbody>{loaderData.invoices.map(row=><tr key={row.id}><td>{row.record_number}</td><td><strong>{row.invoice_number}</strong></td><td>{row.direction==="receivable"?"销项":"进项"} · {row.invoice_type}</td><td>{row.counterparty_name}</td><td>{row.invoice_company}</td><td>{row.currency} {row.amount.toFixed(2)}</td><td>{row.invoice_date}</td></tr>)}</tbody></table></div>{!loaderData.invoices.length&&<p className="empty-state">暂无发票记录。</p>}</section>
    {loaderData.legacyInvoices.length>0&&<details className="panel expandable"><summary>查看升级前历史应收账单（{loaderData.legacyInvoices.length}）</summary><div className="table-wrap"><table><thead><tr><th>账单号</th><th>客户</th><th>金额</th><th>已收</th><th>状态</th></tr></thead><tbody>{loaderData.legacyInvoices.map(row=><tr key={row.id}><td>{row.invoice_number}</td><td>{row.customer_name}</td><td>{row.currency} {row.total_amount.toFixed(2)}</td><td>{row.paid_amount.toFixed(2)}</td><td>{row.status}</td></tr>)}</tbody></table></div></details>}
  </>;
}

function ExpenseSelection({direction,expenses,busy}:{direction:"receivable"|"payable";expenses:SettlementExpense[];busy:boolean}){return <section className="settlement-selector"><header><strong>{direction==="receivable"?"客户应收对账":"供应商应付对账"}</strong><span>{expenses.length} 条可选</span></header><Form method="post"><input type="hidden" name="intent" value="create_reconciliation"/><input type="hidden" name="direction" value={direction}/><div className="settlement-expense-list">{expenses.map(item=><label key={item.id}><input type="checkbox" name="expenseId" value={item.id}/><span><strong><OrderNumberLink id={item.order_id} number={item.order_number}/> · {item.charge_name}</strong><small>{item.counterparty_name} · {item.currency} {item.amount.toFixed(2)}{direction==="receivable"&&!item.outbound_ready?" · 尚未出境":""}</small></span></label>)}</div>{!expenses.length&&<p className="empty-state">暂无符合条件的已确认费用。</p>}<label className="field"><span>对账备注</span><textarea name="notes" rows={2}/></label><button className="primary" disabled={busy||!expenses.length}>生成对账草稿</button></Form></section>}

function ReconciliationSheet({row,manage,cashManage,busy,cash}:{row:ReconciliationRow;manage:boolean;cashManage:boolean;busy:boolean;cash:{id:string;direction:"receipt"|"payment";counterparty_name:string;currency:string;amount:number;allocated_amount:number;transaction_number:string}[]}){
  const invoiceRemaining=Math.max(0,row.total_amount-row.invoiced_amount),settlementRemaining=Math.max(0,row.total_amount-row.settled_amount),matchingCash=cash.filter(item=>item.direction===(row.direction==="receivable"?"receipt":"payment")&&item.counterparty_name===row.counterparty_name&&item.currency===row.currency&&item.amount-item.allocated_amount>0.009);
  return <section className="reconciliation-sheet"><div className="table-wrap reconciliation-summary-table"><table><thead><tr><th>对账单</th><th>方向</th><th>往来单位</th><th>订单</th><th>对账总额</th><th>已开 / 收票</th><th>已核销</th><th>费用行</th><th>状态</th></tr></thead><tbody><tr><td><strong>{row.document_number}</strong></td><td>{row.direction==="receivable"?"客户应收":"供应商应付"}</td><td>{row.counterparty_name}</td><td><OrderNumberLinkList orders={orderReferences(row.order_refs)}/></td><td>{row.currency} {row.total_amount.toFixed(2)}</td><td>{row.invoiced_amount.toFixed(2)}<small>剩余 {invoiceRemaining.toFixed(2)}</small></td><td>{row.settled_amount.toFixed(2)}<small>剩余 {settlementRemaining.toFixed(2)}</small></td><td>{row.expense_count}</td><td><span className={`status-pill ${row.status==="confirmed"?"success":"off"}`}>{row.status==="confirmed"?"已确认":"草稿待确认"}</span></td></tr></tbody></table></div>{row.status==="draft"&&manage?<Form method="post" className="reconciliation-row-action"><input type="hidden" name="intent" value="confirm_reconciliation"/><input type="hidden" name="id" value={row.id}/><p>确认后，费用将进入正式对账状态。</p><button className="primary" disabled={busy}>确认对账单</button></Form>:row.status==="confirmed"&&manage?<div className="reconciliation-actions">{invoiceRemaining>0.009&&<details><summary>登记{row.direction==="receivable"?"销项开票":"进项收票"}</summary><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="record_invoice"/><input type="hidden" name="reconciliationId" value={row.id}/><Num name="amount" label={`本次金额（剩余 ${invoiceRemaining.toFixed(2)}）`} required max={invoiceRemaining}/><Text name="invoiceCompany" label="开票 / 收票公司" required defaultValue={row.settlement_entity}/><Text name="invoiceType" label="发票类别" required defaultValue="增值税发票"/><Text name="invoiceNumber" label="发票号码" required/><Text name="invoiceCode" label="发票代码"/><label className="field"><span>开票日期</span><input name="invoiceDate" type="date" required/></label><Num name="taxRate" label="税率 %"/><Text name="titleName" label="抬头 / 销方" required defaultValue={row.direction==="receivable"?row.settlement_entity:row.counterparty_name}/><Text name="taxNumber" label="税号"/><Text name="addressPhone" label="地址电话"/><Text name="bankAccount" label="开户行账号"/><Num name="exchangeRate" label="汇率" required defaultValue="1"/><Text name="attachmentReference" label="附件 / 凭证编号"/><label className="field span-2"><span>备注</span><input name="invoiceNotes"/></label><button className="primary" disabled={busy}>保存发票记录</button></Form></details>}{cashManage&&settlementRemaining>0.009&&<details><summary>匹配收付款并核销</summary><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="allocate_cash"/><input type="hidden" name="reconciliationId" value={row.id}/><Sel name="transactionId" label="可用流水" items={matchingCash.map(item=>[item.id,`${item.transaction_number} · 剩余 ${(item.amount-item.allocated_amount).toFixed(2)}`])}/><Num name="amount" label={`本次核销（剩余 ${settlementRemaining.toFixed(2)}）`} required max={settlementRemaining}/><button className="primary" disabled={busy||!matchingCash.length}>确认核销</button>{!matchingCash.length&&<small className="field-error">请先在下方登记同往来单位、同币种的收付款流水。</small>}</Form></details>}</div>:null}</section>
}

function Text({name,label,required,defaultValue}:{name:string;label:string;required?:boolean;defaultValue?:string}){return <label className="field"><span>{label}</span><input name={name} required={required} defaultValue={defaultValue}/></label>}
function Num({name,label,required,defaultValue="0",max}:{name:string;label:string;required?:boolean;defaultValue?:string;max?:number}){return <label className="field"><span>{label}</span><input name={name} type="number" min="0" max={max} step="0.01" required={required} defaultValue={defaultValue}/></label>}
function Sel({name,label,items}:{name:string;label:string;items:string[][]}){return <label className="field"><span>{label}</span><select name={name} required><option value="">请选择</option>{items.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>}
function orderReferences(value:string|null){return(value||"").split(",").flatMap(reference=>{const separator=reference.indexOf("|");return separator>0?[{id:reference.slice(0,separator),number:reference.slice(separator+1)}]:[]})}
function positive(form:FormData,name:string,fallback=0){const value=Number(valueOf(form,name)||fallback);return Number.isFinite(value)&&value>0?value:0}
function nonNegative(form:FormData,name:string){const value=Number(valueOf(form,name)||0);return Number.isFinite(value)&&value>=0?value:-1}
function cashStatus(status:string){return{unallocated:"未分配",partially_allocated:"部分分配",allocated:"已分配"}[status]||status}
async function audit(request:Request,current:{organizationId:string;userId:string},action:string,resourceType:string,resourceId:string,metadata:Record<string,unknown>){await writeAudit({request,action,resourceType,resourceId,organizationId:current.organizationId,actorUserId:current.userId,metadata})}
export function meta(){return[{title:"费用结算 | International TMS"}]}
