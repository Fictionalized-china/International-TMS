import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.sales";
import { requireSessionUser } from "../lib/auth.server";
import { validateEmail, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

type Lead = { id: string; company_name: string; contact_name: string | null; email: string | null; phone: string | null; source_code: string | null; owner_name: string | null; status: string; estimated_monthly_shipments: number; created_at: string };
type Opportunity = { id: string; name: string; customer_name: string | null; lead_name: string | null; owner_name: string | null; stage: string; estimated_value: number; currency: string; probability: number; expected_close_date: string | null };
type Activity = { id: string; type: string; subject: string; owner_name: string | null; due_at: string | null; completed_at: string | null; target_name: string | null };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "sales.view");
  const [leads, opportunities, activities, owners, customers, sources, currencies] = await Promise.all([
    env.DB.prepare(`SELECT l.id, l.company_name, l.contact_name, l.email, l.phone, l.source_code, u.display_name AS owner_name, l.status, l.estimated_monthly_shipments, l.created_at FROM sales_leads l LEFT JOIN users u ON u.id = l.owner_user_id WHERE l.organization_id = ? ORDER BY l.created_at DESC LIMIT 200`).bind(current.organizationId).all<Lead>(),
    env.DB.prepare(`SELECT o.id, o.name, c.name AS customer_name, l.company_name AS lead_name, u.display_name AS owner_name, o.stage, o.estimated_value, o.currency, o.probability, o.expected_close_date FROM sales_opportunities o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN sales_leads l ON l.id = o.lead_id LEFT JOIN users u ON u.id = o.owner_user_id WHERE o.organization_id = ? ORDER BY o.updated_at DESC LIMIT 200`).bind(current.organizationId).all<Opportunity>(),
    env.DB.prepare(`SELECT a.id, a.type, a.subject, u.display_name AS owner_name, a.due_at, a.completed_at, COALESCE(c.name, l.company_name, o.name) AS target_name FROM sales_activities a LEFT JOIN users u ON u.id = a.owner_user_id LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN sales_leads l ON l.id = a.lead_id LEFT JOIN sales_opportunities o ON o.id = a.opportunity_id WHERE a.organization_id = ? ORDER BY COALESCE(a.due_at, a.created_at) DESC LIMIT 100`).bind(current.organizationId).all<Activity>(),
    env.DB.prepare(`SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.status = 'active' ORDER BY u.display_name`).bind(current.organizationId).all<{ id: string; display_name: string }>(),
    env.DB.prepare("SELECT id, code, name FROM customers WHERE organization_id = ? AND status IN ('prospect', 'active') ORDER BY name").bind(current.organizationId).all<{ id: string; code: string; name: string }>(),
    env.DB.prepare("SELECT code, name FROM reference_data WHERE organization_id = ? AND category = 'lead_source' AND status = 'active' ORDER BY sort_order").bind(current.organizationId).all<{ code: string; name: string }>(),
    env.DB.prepare("SELECT code, name FROM reference_data WHERE organization_id = ? AND category = 'currency' AND status = 'active' ORDER BY sort_order").bind(current.organizationId).all<{ code: string; name: string }>(),
  ]);
  return { current, leads: leads.results, opportunities: opportunities.results, activities: activities.results, owners: owners.results, customers: customers.results, sources: sources.results, currencies: currencies.results };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "sales.manage");
  const form = await request.formData(), intent = valueOf(form, "intent"), now = new Date().toISOString();
  if (intent === "lead-stage") {
    const id = valueOf(form, "id"), status = valueOf(form, "status");
    if (!['new', 'contacted', 'qualified', 'converted', 'lost'].includes(status)) return { formError: "线索状态无效" };
    const result = await env.DB.prepare("UPDATE sales_leads SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(status, now, id, current.organizationId).run();
    if (!result.meta.changes) return { formError: "线索不存在" };
    await writeAudit({ request, action: "sales.lead.stage", resourceType: "sales_lead", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { status } });
    return { success: "线索状态已更新" };
  }
  if (intent === "opportunity-stage") {
    const id = valueOf(form, "id"), stage = valueOf(form, "stage");
    if (!['discovery', 'solution', 'quotation', 'negotiation', 'won', 'lost'].includes(stage)) return { formError: "商机阶段无效" };
    const probabilities: Record<string, number> = { discovery: 10, solution: 30, quotation: 50, negotiation: 75, won: 100, lost: 0 };
    const result = await env.DB.prepare("UPDATE sales_opportunities SET stage = ?, probability = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(stage, probabilities[stage], now, id, current.organizationId).run();
    if (!result.meta.changes) return { formError: "商机不存在" };
    await writeAudit({ request, action: "sales.opportunity.stage", resourceType: "sales_opportunity", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { stage } });
    return { success: "商机阶段已更新" };
  }
  if (intent === "activity") {
    const type = valueOf(form, "type"), subject = valueOf(form, "subject"), customerId = valueOf(form, "customerId"), ownerId = valueOf(form, "ownerId"), dueAt = valueOf(form, "dueAt"), notes = valueOf(form, "notes");
    if (!['call', 'email', 'meeting', 'task', 'note'].includes(type) || subject.length < 2) return { formError: "活动类型或主题无效" };
    if (customerId && !(await validEntity("customers", customerId, current.organizationId))) return { formError: "关联客户无效" };
    if (ownerId && !(await validOwner(ownerId, current.organizationId))) return { formError: "负责人无效" };
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sales_activities (id, organization_id, customer_id, owner_user_id, type, subject, due_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, current.organizationId, customerId || null, ownerId || current.userId, type, subject, dueAt || null, notes || null, now, now).run();
    await writeAudit({ request, action: "sales.activity.create", resourceType: "sales_activity", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId });
    return { success: "销售活动已创建" };
  }
  if (intent === "opportunity") {
    const name = valueOf(form, "name"), customerId = valueOf(form, "customerId"), leadId = valueOf(form, "leadId"), ownerId = valueOf(form, "ownerId"), currency = valueOf(form, "currency") || "USD", closeDate = valueOf(form, "closeDate"), notes = valueOf(form, "notes"), estimatedValue = Number(valueOf(form, "estimatedValue") || 0);
    if (name.length < 2 || (!customerId && !leadId) || !Number.isFinite(estimatedValue) || estimatedValue < 0) return { formError: "请填写商机名称、关联客户或线索以及有效金额" };
    if (customerId && !(await validEntity("customers", customerId, current.organizationId))) return { formError: "关联客户无效" };
    if (leadId && !(await validEntity("sales_leads", leadId, current.organizationId))) return { formError: "关联线索无效" };
    if (ownerId && !(await validOwner(ownerId, current.organizationId))) return { formError: "负责人无效" };
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sales_opportunities (id, organization_id, customer_id, lead_id, name, owner_user_id, estimated_value, currency, probability, expected_close_date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?)").bind(id, current.organizationId, customerId || null, leadId || null, name, ownerId || current.userId, estimatedValue, currency, closeDate || null, notes || null, now, now).run();
    await writeAudit({ request, action: "sales.opportunity.create", resourceType: "sales_opportunity", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId });
    return { success: "商机已创建" };
  }
  const companyName = valueOf(form, "companyName"), contactName = valueOf(form, "contactName"), email = valueOf(form, "email").toLowerCase(), phone = valueOf(form, "phone"), sourceCode = valueOf(form, "sourceCode"), ownerId = valueOf(form, "ownerId"), notes = valueOf(form, "notes"), shipments = Number(valueOf(form, "shipments") || 0);
  if (companyName.length < 2 || (email && validateEmail(email)) || !Number.isInteger(shipments) || shipments < 0) return { formError: "请填写有效公司名称、邮箱和预计月票数" };
  if (ownerId && !(await validOwner(ownerId, current.organizationId))) return { formError: "负责人无效" };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sales_leads (id, organization_id, company_name, contact_name, email, phone, source_code, owner_user_id, estimated_monthly_shipments, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, current.organizationId, companyName, contactName || null, email || null, phone || null, sourceCode || null, ownerId || current.userId, shipments, notes || null, now, now).run();
  await writeAudit({ request, action: "sales.lead.create", resourceType: "sales_lead", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId });
  return { success: "销售线索已创建" };
}

async function validEntity(table: "customers" | "sales_leads", id: string, organizationId: string) {
  return env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first();
}

async function validOwner(userId: string, organizationId: string) {
  return env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'").bind(userId, organizationId).first();
}

export function meta() { return [{ title: "销售管理 | International TMS" }]; }
const leadLabels: Record<string, string> = { new: "新线索", contacted: "已联系", qualified: "已确认", converted: "已转化", lost: "已流失" };
const stageLabels: Record<string, string> = { discovery: "需求发现", solution: "方案设计", quotation: "报价", negotiation: "谈判", won: "赢单", lost: "输单" };

export default function Sales({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle", canManage = loaderData.current.permissions.includes("sales.manage");
  const pipeline = loaderData.opportunities.filter(item => !['won', 'lost'].includes(item.stage)).reduce((sum, item) => sum + item.estimated_value * item.probability / 100, 0);
  return <><header className="page-header"><div><p className="eyebrow">SALES PIPELINE</p><h1>客户与销售</h1><p>从线索、跟进到商机赢单的轻量销售工作台。</p></div><span className="status-pill">销售漏斗运行中</span></header>
    <section className="stats"><article><span>开放线索</span><strong>{loaderData.leads.filter(item => !['converted', 'lost'].includes(item.status)).length}</strong><small>待推进</small></article><article><span>开放商机</span><strong>{loaderData.opportunities.filter(item => !['won', 'lost'].includes(item.stage)).length}</strong><small>销售机会</small></article><article><span>加权漏斗</span><strong>{Math.round(pipeline).toLocaleString()}</strong><small>按商机概率折算</small></article></section>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    {canManage && <section className="action-grid sales-actions"><details className="panel expandable" open={loaderData.leads.length === 0}><summary>创建销售线索</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="lead"/><label className="field"><span>公司名称</span><input name="companyName" required/></label><label className="field"><span>联系人</span><input name="contactName"/></label><label className="field"><span>邮箱</span><input name="email" type="email"/></label><label className="field"><span>电话</span><input name="phone"/></label><label className="field"><span>线索来源</span><select name="sourceCode"><option value="">未指定</option>{loaderData.sources.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><OwnerSelect owners={loaderData.owners}/><label className="field"><span>预计月票数</span><input name="shipments" type="number" min="0" defaultValue="0"/></label><label className="field"><span>备注</span><input name="notes"/></label><button className="primary" disabled={busy}>创建线索</button></Form></details><details className="panel expandable"><summary>创建商机</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="opportunity"/><label className="field"><span>商机名称</span><input name="name" required/></label><label className="field"><span>关联客户</span><select name="customerId"><option value="">请选择</option>{loaderData.customers.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="field"><span>或关联线索</span><select name="leadId"><option value="">请选择</option>{loaderData.leads.map(item => <option key={item.id} value={item.id}>{item.company_name}</option>)}</select></label><OwnerSelect owners={loaderData.owners}/><label className="field"><span>预计金额</span><input name="estimatedValue" type="number" min="0" step="0.01" defaultValue="0"/></label><label className="field"><span>币种</span><select name="currency">{loaderData.currencies.map(item => <option key={item.code} value={item.code}>{item.code}</option>)}</select></label><label className="field"><span>预计成交日</span><input name="closeDate" type="date"/></label><label className="field"><span>备注</span><input name="notes"/></label><button className="primary" disabled={busy}>创建商机</button></Form></details><details className="panel expandable"><summary>记录销售活动</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="activity"/><label className="field"><span>活动类型</span><select name="type"><option value="call">电话</option><option value="email">邮件</option><option value="meeting">会议</option><option value="task">任务</option><option value="note">备注</option></select></label><label className="field"><span>主题</span><input name="subject" required/></label><label className="field"><span>关联客户</span><select name="customerId"><option value="">未关联</option>{loaderData.customers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><OwnerSelect owners={loaderData.owners}/><label className="field"><span>计划时间</span><input name="dueAt" type="datetime-local"/></label><label className="field"><span>记录</span><input name="notes"/></label><button className="primary" disabled={busy}>记录活动</button></Form></details></section>}
    <section className="panel"><h2>销售线索</h2><div className="table-wrap"><table><thead><tr><th>公司/联系人</th><th>负责人</th><th>预计月票</th><th>来源</th><th>状态</th></tr></thead><tbody>{loaderData.leads.map(lead => <tr key={lead.id}><td><strong>{lead.company_name}</strong><small>{lead.contact_name || lead.email || lead.phone || "—"}</small></td><td>{lead.owner_name || "—"}</td><td>{lead.estimated_monthly_shipments}</td><td>{lead.source_code || "—"}</td><td>{canManage ? <Form method="post" className="inline-form"><input type="hidden" name="intent" value="lead-stage"/><input type="hidden" name="id" value={lead.id}/><select name="status" defaultValue={lead.status}>{Object.entries(leadLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select><button className="text-button">更新</button></Form> : leadLabels[lead.status]}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><h2>商机漏斗</h2><div className="table-wrap"><table><thead><tr><th>商机</th><th>客户/线索</th><th>负责人</th><th>金额</th><th>概率</th><th>阶段</th></tr></thead><tbody>{loaderData.opportunities.map(item => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.expected_close_date || "未设成交日"}</small></td><td>{item.customer_name || item.lead_name || "—"}</td><td>{item.owner_name || "—"}</td><td>{item.currency} {item.estimated_value.toLocaleString()}</td><td>{item.probability}%</td><td>{canManage ? <Form method="post" className="inline-form"><input type="hidden" name="intent" value="opportunity-stage"/><input type="hidden" name="id" value={item.id}/><select name="stage" defaultValue={item.stage}>{Object.entries(stageLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select><button className="text-button">更新</button></Form> : stageLabels[item.stage]}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><h2>最近销售活动</h2>{loaderData.activities.length ? <div className="simple-list">{loaderData.activities.map(item => <div key={item.id}><div><strong>{item.subject}</strong><small>{item.target_name || "未关联客户"} · {item.owner_name || "未分配"}</small></div><span>{item.due_at ? new Date(item.due_at).toLocaleString("zh-CN") : item.type}</span></div>)}</div> : <p className="empty-state">暂无销售活动。</p>}</section>
  </>;
}

function OwnerSelect({ owners }: { owners: { id: string; display_name: string }[] }) {
  return <label className="field"><span>负责人</span><select name="ownerId"><option value="">当前用户</option>{owners.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>;
}
