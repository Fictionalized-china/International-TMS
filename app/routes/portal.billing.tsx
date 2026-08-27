import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/portal.billing";
import { Modal } from "../components/Modal";
import { requirePortalCustomer } from "../lib/portal.server";

type Invoice={id:string;invoice_number:string;shipment_number:string|null;currency:string;total_amount:number;paid_amount:number;issue_date:string|null;due_date:string|null;status:string;lines:string|null};
type Payment={id:string;invoice_number:string;amount:number;currency:string;payment_date:string;reference:string|null;status:string;submitted_at:string;attachment_count:number};
type Dispute={id:string;invoice_number:string;category:string;description:string;status:string;resolution:string|null;created_at:string};
const invoiceLabels:Record<string,string>={issued:"待付款",partially_paid:"部分付款",paid:"已付清",overdue:"已逾期"};
const paymentLabels:Record<string,string>={pending:"待审核",approved:"已确认",rejected:"已驳回"};
const disputeLabels:Record<string,string>={open:"待处理",processing:"处理中",resolved:"已解决",rejected:"已驳回"};

export async function loader({request}:Route.LoaderArgs){
  const {user,customer}=await requirePortalCustomer(request),url=new URL(request.url),status=url.searchParams.get("status")??"",currency=url.searchParams.get("currency")??"";
  const conditions=["i.organization_id=?","i.customer_id=?","i.status IN ('issued','partially_paid','paid','overdue')"],bindings:unknown[]=[user.organizationId,customer.id];
  if(status&&["issued","partially_paid","paid","overdue"].includes(status)){conditions.push("i.status=?");bindings.push(status)}
  if(currency&&/^[A-Z]{3}$/.test(currency)){conditions.push("i.currency=?");bindings.push(currency)}
  const [invoices,payments,disputes]=await Promise.all([
    env.DB.prepare(`SELECT i.id,i.invoice_number,s.shipment_number,i.currency,i.total_amount,i.paid_amount,i.issue_date,i.due_date,i.status,GROUP_CONCAT(il.description||': '||printf('%.2f',il.amount),'；') lines FROM invoices i LEFT JOIN shipments s ON s.id=i.shipment_id LEFT JOIN invoice_lines il ON il.invoice_id=i.id WHERE ${conditions.join(" AND ")} GROUP BY i.id ORDER BY i.created_at DESC`).bind(...bindings).all<Invoice>(),
    env.DB.prepare("SELECT p.id,i.invoice_number,p.amount,p.currency,p.payment_date,p.reference,p.status,p.submitted_at,COUNT(a.id) attachment_count FROM payment_submissions p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN payment_attachments a ON a.payment_submission_id=p.id WHERE p.organization_id=? AND p.customer_id=? GROUP BY p.id ORDER BY p.submitted_at DESC LIMIT 30").bind(user.organizationId,customer.id).all<Payment>(),
    env.DB.prepare("SELECT d.id,i.invoice_number,d.category,d.description,d.status,d.resolution,d.created_at FROM invoice_disputes d JOIN invoices i ON i.id=d.invoice_id WHERE d.organization_id=? AND d.customer_id=? ORDER BY d.created_at DESC LIMIT 30").bind(user.organizationId,customer.id).all<Dispute>()
  ]);
  return{invoices:invoices.results,payments:payments.results,disputes:disputes.results,filters:{status,currency}};
}

export async function action({request}:Route.ActionArgs){
  const {user,customer}=await requirePortalCustomer(request),form=await request.formData(),intent=String(form.get("intent")??""),invoiceId=String(form.get("invoiceId")??""),now=new Date().toISOString();
  const invoice=await env.DB.prepare("SELECT id,invoice_number,currency,total_amount,paid_amount,status FROM invoices WHERE id=? AND organization_id=? AND customer_id=? AND status IN ('issued','partially_paid','overdue')").bind(invoiceId,user.organizationId,customer.id).first<{id:string;invoice_number:string;currency:string;total_amount:number;paid_amount:number;status:string}>();
  if(!invoice)return{formError:"账单不存在或当前不可操作"};
  if(intent==="payment_submit"){
    const amount=Number(form.get("amount")),paymentDate=String(form.get("paymentDate")??""),reference=String(form.get("reference")??"").trim(),notes=String(form.get("notes")??"").trim(),file=form.get("attachment");
    if(!Number.isFinite(amount)||amount<=0||amount>invoice.total_amount-invoice.paid_amount+0.001)return{formError:"付款金额必须大于 0 且不能超过待付余额"};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate))return{formError:"请选择有效的付款日期"};
    if(!(file instanceof File)||file.size===0)return{formError:"请上传付款凭证"};
    const allowed=["application/pdf","image/jpeg","image/png","image/webp"];
    if(file.size>2*1024*1024||!allowed.includes(file.type))return{formError:"付款凭证仅支持 PDF、JPG、PNG、WebP，且不超过 2 MB"};
    const id=crypto.randomUUID(),bytes=new Uint8Array(await file.arrayBuffer());let binary="";
    for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO payment_submissions(id,organization_id,customer_id,invoice_id,amount,currency,payment_date,reference,notes,status,submitted_by_user_id,submitted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)").bind(id,user.organizationId,customer.id,invoice.id,amount,invoice.currency,paymentDate,reference||null,notes||null,user.userId,now,now,now),
      env.DB.prepare("INSERT INTO payment_attachments(id,organization_id,payment_submission_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),user.organizationId,id,file.name,file.type,file.size,`data:${file.type};base64,${btoa(binary)}`,user.userId,now),
      env.DB.prepare("INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(),user.organizationId,customer.id,user.userId,"payment","付款凭证已提交",`账单 ${invoice.invoice_number} 的付款凭证正在审核。`,"/portal/billing",now)
    ]);return{success:"付款凭证已提交，我们会尽快审核"};
  }
  if(intent==="dispute_submit"){
    const category=String(form.get("category")??""),description=String(form.get("description")??"").trim();
    if(!["amount","duplicate","service","tax","other"].includes(category)||description.length<5||description.length>1000)return{formError:"请选择异议类型，并填写 5–1000 字的说明"};
    const existing=await env.DB.prepare("SELECT id FROM invoice_disputes WHERE invoice_id=? AND customer_id=? AND status IN ('open','processing')").bind(invoice.id,customer.id).first();if(existing)return{formError:"该账单已有待处理异议"};
    await env.DB.batch([
      env.DB.prepare("INSERT INTO invoice_disputes(id,organization_id,customer_id,invoice_id,category,description,status,submitted_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',?,?,?)").bind(crypto.randomUUID(),user.organizationId,customer.id,invoice.id,category,description,user.userId,now,now),
      env.DB.prepare("INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(),user.organizationId,customer.id,user.userId,"invoice","账单异议已受理",`账单 ${invoice.invoice_number} 的异议已进入处理队列。`,"/portal/billing",now)
    ]);return{success:"账单异议已提交"};
  }
  return{formError:"无效操作"};
}

export default function PortalBilling({loaderData,actionData}:Route.ComponentProps){const busy=useNavigation().state!=="idle",due=loaderData.invoices.reduce((sum,x)=>sum+Math.max(0,x.total_amount-x.paid_amount),0);return <>
  <header className="page-header"><div><p className="eyebrow">BILLING</p><h1>我的账单</h1><p>查询账单、下载明细、提交付款凭证并跟踪账单异议。</p></div><span className="status-pill">待付余额 {due.toLocaleString()}</span></header>
  {(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>{actionData.formError??actionData.success}</div>}
  <section className="panel"><Form method="get" action="." className="billing-filters"><select name="status" defaultValue={loaderData.filters.status}><option value="">全部状态</option>{Object.entries(invoiceLabels).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select><input name="currency" maxLength={3} defaultValue={loaderData.filters.currency} placeholder="币种，如 USD"/><button className="secondary">筛选</button><Link className="text-button" to="/portal/billing">重置</Link></Form><div className="table-wrap"><table><thead><tr><th>账单号</th><th>运单</th><th>费用明细</th><th>金额</th><th>已付 / 待付</th><th>到期日</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.invoices.map(i=>{const outstanding=Math.max(0,i.total_amount-i.paid_amount);return <tr key={i.id}><td><strong>{i.invoice_number}</strong><small>{i.issue_date||"—"}</small></td><td>{i.shipment_number||"独立账单"}</td><td>{i.lines||"—"}</td><td>{i.currency} {i.total_amount.toLocaleString()}</td><td>{i.paid_amount.toLocaleString()} / {outstanding.toLocaleString()}</td><td>{i.due_date||"—"}</td><td><span className={`status-pill ${i.status==="overdue"?"off":""}`}>{invoiceLabels[i.status]}</span></td><td><div className="billing-actions"><a className="text-button" href={`/portal/invoices/${i.id}/download`}>下载</a>{outstanding>0&&<Modal title={`提交付款凭证 · ${i.invoice_number}`} triggerLabel="付款凭证" triggerClassName="text-button" closeSignal={actionData?.success}><PaymentForm invoice={i} busy={busy}/></Modal>}<Modal title={`账单异议 · ${i.invoice_number}`} triggerLabel="提出异议" triggerClassName="text-button danger" closeSignal={actionData?.success}><DisputeForm invoice={i} busy={busy}/></Modal></div></td></tr>})}</tbody></table></div>{!loaderData.invoices.length&&<p className="empty-state">没有符合条件的账单。</p>}</section>
  <section className="billing-history"><History title="付款凭证记录" empty="尚未提交付款凭证">{loaderData.payments.map(x=><div key={x.id}><span><strong>{x.invoice_number}</strong><small>{x.payment_date} · {x.attachment_count} 个附件</small></span><span>{x.currency} {x.amount.toLocaleString()}<small>{x.reference||"无流水号"}</small></span><span className="status-pill">{paymentLabels[x.status]}</span></div>)}</History><History title="账单异议记录" empty="尚未提交账单异议">{loaderData.disputes.map(x=><div key={x.id}><span><strong>{x.invoice_number}</strong><small>{x.created_at.slice(0,10)}</small></span><span>{x.description}<small>{x.resolution||"等待处理"}</small></span><span className="status-pill">{disputeLabels[x.status]}</span></div>)}</History></section>
  </>}

function PaymentForm({invoice,busy}:{invoice:Invoice;busy:boolean}){const outstanding=Math.max(0,invoice.total_amount-invoice.paid_amount);return <Form method="post" encType="multipart/form-data" className="stack"><input type="hidden" name="intent" value="payment_submit"/><input type="hidden" name="invoiceId" value={invoice.id}/><label className="field"><span>付款金额（{invoice.currency}）</span><input name="amount" type="number" min="0.01" max={outstanding} step="0.01" defaultValue={outstanding} required/></label><label className="field"><span>付款日期</span><input name="paymentDate" type="date" required/></label><label className="field"><span>银行流水号 / 参考号</span><input name="reference" maxLength={100}/></label><label className="field"><span>付款凭证</span><input name="attachment" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required/><small>PDF、JPG、PNG 或 WebP，不超过 2 MB。</small></label><label className="field"><span>备注</span><textarea name="notes" rows={3} maxLength={500}/></label><button className="primary portal-primary" disabled={busy}>提交审核</button></Form>}
function DisputeForm({invoice,busy}:{invoice:Invoice;busy:boolean}){return <Form method="post" className="stack"><input type="hidden" name="intent" value="dispute_submit"/><input type="hidden" name="invoiceId" value={invoice.id}/><label className="field"><span>异议类型</span><select name="category" required><option value="amount">金额不符</option><option value="duplicate">重复收费</option><option value="service">服务内容不符</option><option value="tax">税费问题</option><option value="other">其他</option></select></label><label className="field"><span>问题说明</span><textarea name="description" rows={6} minLength={5} maxLength={1000} required/></label><button className="primary portal-primary" disabled={busy}>提交异议</button></Form>}
function History({title,empty,children}:{title:string;empty:string;children:React.ReactNode}){return <section className="panel"><div className="panel-header"><h2>{title}</h2></div><div className="account-list">{children}</div>{!children&&<p className="empty-state">{empty}</p>}</section>}
export function meta(){return[{title:"我的账单 | 欧凌客户门户"}]}
