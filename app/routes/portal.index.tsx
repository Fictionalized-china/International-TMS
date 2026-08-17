import { env } from "cloudflare:workers";
import type { Route } from "./+types/portal.index";
import { requireSessionUser } from "../lib/auth.server";

type CustomerSummary = { id: string; code: string; name: string; status: string };
type Contact = { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: number };
type Address = { id: string; label: string; type: string; country_code: string; city: string; address_line1: string; is_default: number };

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, undefined, "portal");
  const customer = await env.DB.prepare(`SELECT c.id, c.code, c.name, c.status FROM customer_portal_accounts cpa JOIN customers c ON c.id = cpa.customer_id WHERE cpa.user_id = ? AND cpa.organization_id = ? AND cpa.status = 'active' LIMIT 1`).bind(user.userId, user.organizationId).first<CustomerSummary>();
  if (!customer) throw new Response("客户门户账户未关联客户", { status: 403 });
  const [contacts, addresses, orders, shipments, invoices] = await Promise.all([
    env.DB.prepare("SELECT id, name, title, email, phone, is_primary FROM customer_contacts WHERE customer_id = ? ORDER BY is_primary DESC, name").bind(customer.id).all<Contact>(),
    env.DB.prepare("SELECT id, label, type, country_code, city, address_line1, is_default FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, label").bind(customer.id).all<Address>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM transport_orders WHERE organization_id = ? AND customer_id = ? AND status NOT IN ('completed','cancelled')").bind(user.organizationId, customer.id).first<{count:number}>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM shipments WHERE organization_id = ? AND customer_id = ? AND status NOT IN ('delivered','cancelled')").bind(user.organizationId, customer.id).first<{count:number}>(),
    env.DB.prepare("SELECT COALESCE(SUM(total_amount-paid_amount),0) AS amount FROM invoices WHERE organization_id = ? AND customer_id = ? AND status IN ('issued','partially_paid','overdue')").bind(user.organizationId, customer.id).first<{amount:number}>(),
  ]);
  return { user, customer, contacts: contacts.results, addresses: addresses.results, summary: { orders: Number(orders?.count??0), shipments: Number(shipments?.count??0), outstanding: Number(invoices?.amount??0) } };
}

export function meta() { return [{ title: "客户门户 | International TMS" }]; }

export default function PortalIndex({ loaderData }: Route.ComponentProps) {
  return <><header className="page-header portal-hero"><div><p className="eyebrow">CUSTOMER PORTAL</p><h1>{loaderData.customer.name}</h1><p>客户代码 {loaderData.customer.code} · 账户状态 {loaderData.customer.status === "active" ? "正常" : loaderData.customer.status}</p></div><span className="status-pill">门户已启用</span></header>
    <section className="stats"><article><span>执行中订单</span><strong>{loaderData.summary.orders}</strong><small>待确认或执行</small></article><article><span>在途运单</span><strong>{loaderData.summary.shipments}</strong><small>运输执行中</small></article><article><span>待付余额</span><strong>{loaderData.summary.outstanding.toLocaleString()}</strong><small>已开具账单</small></article></section>
    <section className="portal-grid"><article className="panel"><h2>联系人</h2>{loaderData.contacts.length ? <div className="simple-list">{loaderData.contacts.map(contact => <div key={contact.id}><div><strong>{contact.name}</strong><small>{contact.title || "联系人"}</small></div><span>{contact.email || contact.phone || "—"}</span></div>)}</div> : <p className="empty-state">暂无联系人，请联系客户经理维护。</p>}</article><article className="panel"><h2>常用地址</h2>{loaderData.addresses.length ? <div className="simple-list">{loaderData.addresses.map(address => <div key={address.id}><div><strong>{address.label}</strong><small>{address.country_code} · {address.city}</small></div><span>{address.address_line1}</span></div>)}</div> : <p className="empty-state">暂无常用地址。</p>}</article></section>
  </>;
}
