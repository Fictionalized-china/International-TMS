import { env } from "cloudflare:workers";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Route } from "./+types/admin.quotations";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { transportChargeNameOptions } from "../lib/charge-options";
import { nextDocumentNumber } from "../lib/documents.server";
import {
  acceptQuotation,
  voidQuotation,
  withdrawQuotationAcceptance,
} from "../lib/quotation-lifecycle.server";
import { requirePositiveInteger, requirePositiveNumber, valueOf } from "../lib/validation";

type Quote = {
  id: string;
  quote_number: string;
  customer_name: string;
  customer_contact_name: string | null;
  customer_contact_phone: string | null;
  salesperson_name: string | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  pickup_address: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_warehouse_name: string | null;
  destination_warehouse_note: string | null;
  customs_clearance_mode: "company" | "customer";
  transport_mode: string;
  road_load_type: "ftl" | "ltl";
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  estimated_length_cm: number;
  estimated_width_cm: number;
  estimated_height_cm: number;
  total_amount: number;
  valid_until: string | null;
  lifecycle_status: "pending" | "accepted" | "withdrawn" | "void";
  order_id: string | null;
  order_number: string | null;
  order_status: string | null;
  current_step_code: string | null;
  created_at: string;
};

type CustomerOption = {
  id: string;
  name: string;
  pickup_address: string | null;
  pickup_country_code: string | null;
  pickup_state_code: string | null;
  pickup_city: string | null;
  contact_name: string | null;
  contact_phone: string | null;
};
type CustomerContactOption = {
  id: string;
  customer_id: string;
  name: string;
  phone: string | null;
  is_primary: number;
};

type UserOption = { id: string; display_name: string; email: string };
type WarehouseOption = { id: string; name: string; country_code: string | null; city: string | null; address: string | null };
type GeoOption = { code: string; name: string; parent_code: string | null };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "quote.view");
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("q") || "").trim();
  const lifecycle = (url.searchParams.get("status") || "").trim();
  const where = ["q.organization_id=?"];
  const binds: unknown[] = [current.organizationId];
  if (keyword) {
    where.push("(q.quote_number LIKE ? OR c.name LIKE ? OR q.cargo_description LIKE ? OR o.order_number LIKE ?)");
    const like = `%${keyword}%`;
    binds.push(like, like, like, like);
  }
  if (["pending", "accepted", "withdrawn", "void"].includes(lifecycle)) {
    where.push("q.lifecycle_status=?");
    binds.push(lifecycle);
  }
  const [quotes, customers, contacts, users, warehouses, countries, provinces, cities] = await Promise.all([
    env.DB.prepare(
      `SELECT q.id,q.quote_number,c.name customer_name,q.customer_contact_name,q.customer_contact_phone,u.display_name salesperson_name,
        q.origin_country,q.origin_state,q.origin_city,q.pickup_address,
        q.destination_country,q.destination_state,q.destination_city,
        w.name destination_warehouse_name,q.destination_warehouse_note,q.customs_clearance_mode,
        q.transport_mode,q.road_load_type,q.cargo_description,q.pieces,q.gross_weight_kg,q.volume_cbm,
        q.estimated_length_cm,q.estimated_width_cm,q.estimated_height_cm,q.total_amount,q.valid_until,
        q.lifecycle_status,o.id order_id,o.order_number,o.status order_status,o.current_step_code,q.created_at
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id
       LEFT JOIN users u ON u.id=q.salesperson_user_id
       LEFT JOIN warehouses w ON w.id=q.destination_warehouse_id
       LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
       WHERE ${where.join(" AND ")}
       ORDER BY q.created_at DESC LIMIT 200`,
    ).bind(...binds).all<Quote>(),
    env.DB.prepare(
      `SELECT c.id,c.name,
        (SELECT a.address_line1 FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_address,
        (SELECT a.country_code FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_country_code,
        (SELECT a.state FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_state_code,
        (SELECT a.city FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_city,
        (SELECT cc.name FROM customer_contacts cc WHERE cc.customer_id=c.id ORDER BY cc.is_primary DESC,cc.created_at LIMIT 1) contact_name,
        (SELECT cc.phone FROM customer_contacts cc WHERE cc.customer_id=c.id ORDER BY cc.is_primary DESC,cc.created_at LIMIT 1) contact_phone
       FROM customers c WHERE c.organization_id=? AND c.status='active' ORDER BY c.name`,
    ).bind(current.organizationId).all<CustomerOption>(),
    env.DB.prepare(
      `SELECT cc.id,cc.customer_id,cc.name,cc.phone,cc.is_primary
       FROM customer_contacts cc
       JOIN customers c ON c.id=cc.customer_id
       WHERE c.organization_id=? AND c.status='active'
       ORDER BY cc.customer_id,cc.is_primary DESC,cc.updated_at DESC,cc.name`,
    ).bind(current.organizationId).all<CustomerContactOption>(),
    env.DB.prepare(
      `SELECT u.id,u.display_name,u.email FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY u.display_name,u.email`,
    ).bind(current.organizationId).all<UserOption>(),
    env.DB.prepare(
      `SELECT id,name,country_code,city,address FROM warehouses
       WHERE organization_id=? AND warehouse_role='overseas_destination' AND status='active' ORDER BY name`,
    ).bind(current.organizationId).all<WarehouseOption>(),
    geoOptions(current.organizationId, "country"),
    geoOptions(current.organizationId, "province"),
    geoOptions(current.organizationId, "city"),
  ]);
  return {
    current,
    quotes: quotes.results ?? [],
    customers: customers.results ?? [],
    contacts: contacts.results ?? [],
    users: users.results ?? [],
    warehouses: warehouses.results ?? [],
    countries,
    provinces,
    cities,
    filters: { keyword, lifecycle },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "quote.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  try {
    if (intent === "create") {
      const customerId = valueOf(form, "customerId");
      const salespersonId = valueOf(form, "salespersonId");
      const transportMode = valueOf(form, "transportMode");
      const roadLoadType = valueOf(form, "roadLoadType");
      const customerContactName = valueOf(form, "customerContactName");
      const customerContactPhone = valueOf(form, "customerContactPhone");
      const pickupAddress = valueOf(form, "pickupAddress");
      const originCountry = valueOf(form, "originCountry");
      const originState = valueOf(form, "originState");
      const originCity = valueOf(form, "originCity");
      const destinationCountry = valueOf(form, "destinationCountry");
      const destinationState = valueOf(form, "destinationState");
      const destinationCity = valueOf(form, "destinationCity");
      const destinationWarehouseId = valueOf(form, "destinationWarehouseId");
      const destinationWarehouseNote = valueOf(form, "destinationWarehouseNote");
      const customsClearanceMode = valueOf(form, "customsClearanceMode");
      const cargoDescription = valueOf(form, "cargoDescription");
      const pieces = requirePositiveInteger(valueOf(form, "pieces"), "预计件数");
      const weight = requirePositiveNumber(valueOf(form, "weight"), "预计重量");
      const length = requirePositiveNumber(valueOf(form, "length"), "预计长度");
      const width = requirePositiveNumber(valueOf(form, "width"), "预计宽度");
      const height = requirePositiveNumber(valueOf(form, "height"), "预计高度");
      const volume = requirePositiveNumber(valueOf(form, "volume"), "预计体积");
      const validUntil = valueOf(form, "validUntil");
      const notes = valueOf(form, "notes");
      if (!customerId || !salespersonId || transportMode !== "ROAD" || !["ftl", "ltl"].includes(roadLoadType)) {
        throw new Error("请选择客户、业务员、汽运和整车/拼车类型");
      }
      if (![customerContactName, customerContactPhone, pickupAddress, originCountry, originState, originCity, destinationCountry, destinationState, destinationCity, destinationWarehouseId, cargoDescription].every(Boolean)) {
        throw new Error("请完整填写客户联系人、联系电话、提货地址、起运地、目的地、目的仓和货物描述");
      }
      if (!["company", "customer"].includes(customsClearanceMode)) throw new Error("请选择清关办理方式");
      await Promise.all([
        assertGeoHierarchy(current.organizationId, originCountry, originState, originCity, "起运地"),
        assertGeoHierarchy(current.organizationId, destinationCountry, destinationState, destinationCity, "目的地"),
      ]);
      const [customer, salesperson, warehouse] = await Promise.all([
        env.DB.prepare("SELECT id FROM customers WHERE id=? AND organization_id=? AND status='active'").bind(customerId,current.organizationId).first(),
        env.DB.prepare("SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=? AND m.organization_id=? AND u.status='active' AND m.status='active'").bind(salespersonId,current.organizationId).first(),
        env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND organization_id=? AND warehouse_role='overseas_destination' AND status='active'").bind(destinationWarehouseId,current.organizationId).first(),
      ]);
      if (!customer || !salesperson || !warehouse) throw new Error("客户、业务员或目的仓已停用");
      const chargeNames = form.getAll("chargeName").map(String);
      const quantities = form.getAll("chargeQuantity").map(Number);
      const unitPrices = form.getAll("chargeUnitPrice").map(Number);
      const chargeNotes = form.getAll("chargeNotes").map(String);
      if (!chargeNames.length || chargeNames.some((name) => !name)) throw new Error("至少填写一条应收费用");
      const charges = chargeNames.map((name, index) => {
        const quantity = quantities[index];
        const unitPrice = unitPrices[index];
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
          throw new Error(`第 ${index + 1} 条费用的数量或单价无效`);
        }
        return { name, quantity, unitPrice, amount: quantity * unitPrice, notes: chargeNotes[index] || null };
      });
      const total = charges.reduce((sum, item) => sum + item.amount, 0);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const number = await nextDocumentNumber(current.organizationId, "quote");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO quotations(
            id,organization_id,quote_number,customer_id,origin_country,origin_state,origin_city,pickup_address,
            destination_country,destination_state,destination_city,destination_warehouse_id,destination_warehouse_note,
            estimated_length_cm,estimated_width_cm,estimated_height_cm,customs_clearance_mode,
            transport_mode,road_load_type,cargo_description,pieces,gross_weight_kg,volume_cbm,currency,
            subtotal,tax_amount,total_amount,valid_until,status,lifecycle_status,notes,salesperson_user_id,
            created_by_user_id,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CNY',?,0,?,?, 'sent','pending',?,?,?,?,?)`,
        ).bind(
          id,current.organizationId,number,customerId,originCountry,originState,originCity,pickupAddress,
          destinationCountry,destinationState,destinationCity,destinationWarehouseId,destinationWarehouseNote || null,
          length,width,height,customsClearanceMode,transportMode,roadLoadType,cargoDescription,pieces,weight,volume,
          total,total,validUntil || null,notes || null,salespersonId,current.userId,now,now,
        ),
        env.DB.prepare(
          "UPDATE quotations SET customer_contact_name=?,customer_contact_phone=? WHERE id=? AND organization_id=?",
        ).bind(customerContactName,customerContactPhone,id,current.organizationId),
        ...charges.map((charge, index) => env.DB.prepare(
          `INSERT INTO quotation_charges(
            id,quotation_id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order,created_at
           ) VALUES(?,?,?,?,?,?,?,1,?,?)`,
        ).bind(crypto.randomUUID(),id,`RECEIVABLE_${index + 1}`,charge.name,charge.quantity,charge.unitPrice,charge.amount,(index + 1) * 10,now)),
        env.DB.prepare(
          `INSERT INTO portal_notifications(
            id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at
           ) VALUES(?,?,?,?,?,?,?,?,0,?)`,
        ).bind(crypto.randomUUID(),current.organizationId,customerId,null,"quote","新报价待确认",`报价 ${number} 等待确认。`,`/portal/quotes`,now),
      ]);
      return { success: `报价 ${number} 已保存并进入待客户确认` };
    }
    const quotationId = valueOf(form, "id");
    if (!quotationId) throw new Error("缺少报价编号");
    if (intent === "accept") {
      const result = await acceptQuotation({ organizationId: current.organizationId, quotationId, actorUserId: current.userId, source: "admin", request });
      return { success: `客户报价已确认，${result.created ? "自动创建" : "恢复"}订单 ${result.orderNumber}` };
    }
    if (intent === "withdraw") {
      const result = await withdrawQuotationAcceptance({ organizationId: current.organizationId, quotationId, actorUserId: current.userId, source: "admin" });
      return { success: `报价接受已撤回，订单 ${result.orderNumber || ""} 已保留` };
    }
    if (intent === "void") {
      await voidQuotation({ organizationId: current.organizationId, quotationId, actorUserId: current.userId, source: "admin" });
      return { success: "报价已作废" };
    }
    throw new Error("未知操作");
  } catch (error) {
    return { formError: error instanceof Error ? error.message : String(error) };
  }
}

export default function QuotationsPage({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const stats = useMemo(() => ({
    pending: loaderData.quotes.filter((quote) => quote.lifecycle_status === "pending").length,
    accepted: loaderData.quotes.filter((quote) => quote.lifecycle_status === "accepted").length,
    orders: loaderData.quotes.filter((quote) => quote.order_id).length,
  }), [loaderData.quotes]);
  return <div className="page prototype-page">
    <div className="breadcrumb">管理后台 / 工作台 / <b>询价与报价</b></div>
    <div className="page-head">
      <div><span className="eyebrow">QUOTE DESK / 询价与报价</span><h1>询价与报价</h1><p>报价被接受后立即生成唯一运输订单，不再二次创建订单。</p></div>
      <div className="head-actions"><Modal title="创建运输报价" triggerLabel="创建报价" triggerClassName="btn primary" closeSignal={actionData?.success} size="xwide" dialogClassName="quote-form-modal"><QuoteForm loaderData={loaderData} busy={busy} /></Modal></div>
    </div>
    {(actionData?.success || actionData?.formError) && <div className={`gate ${actionData.formError ? "" : "ok"}`}>{actionData.formError || actionData.success}</div>}
    <div className="kpis quotation-kpis">
      <div className="panel"><span>待客户确认</span><b>{stats.pending}</b></div>
      <div className="panel"><span>已接受</span><b>{stats.accepted}</b></div>
      <div className="panel"><span>自动生成订单</span><b>{stats.orders}</b></div>
      <div className="panel"><span>规则</span><b>一报一单</b></div>
    </div>
    <Form className="panel filters quotation-filters" method="get" action=".">
      <div className="field"><label>报价号 / 客户 / 货物 / 订单号</label><input className="control" name="q" defaultValue={loaderData.filters.keyword} /></div>
      <div className="field"><label>状态</label><select className="control" name="status" defaultValue={loaderData.filters.lifecycle}><option value="">全部</option><option value="pending">待确认</option><option value="accepted">已接受</option><option value="withdrawn">已撤回</option><option value="void">已作废</option></select></div>
      <button className="btn primary">筛选</button><Link className="btn" to="/admin/quotations">重置</Link>
    </Form>
    <section className="panel table-panel">
      <div className="panel-head"><div><h2>报价单 <span className="count">{loaderData.quotes.length}</span></h2><p>运输类型在报价接受后锁定，订单仅由报价生成。</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>报价单号</th><th>客户 / 业务员</th><th>运输方案</th><th>货物 / 线路</th><th>应收总额</th><th>状态</th><th>关联订单</th><th>操作</th></tr></thead><tbody>
        {loaderData.quotes.map((quote) => <tr key={quote.id}><td><span className="order-id">{quote.quote_number}</span><span className="subline">{new Date(quote.created_at).toLocaleString("zh-CN")}</span></td><td><span className="cell-main">{quote.customer_name}</span><span className="subline">{quote.salesperson_name || "待指定业务员"}</span></td><td><span className={`pill ${quote.road_load_type === "ltl" ? "ltl" : ""}`}>{quote.road_load_type === "ltl" ? "拼车" : "整车"}</span><span className="subline">汽运 · {quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}</span></td><td><span className="cell-main">{quote.cargo_description}</span><span className="subline">{quote.origin_city} → {quote.destination_city} · {quote.destination_warehouse_name || "目的仓待补"}</span></td><td><span className="cell-main">CNY {quote.total_amount.toLocaleString()}</span><span className="subline">{quote.pieces} 件 · {quote.gross_weight_kg} KG · {quote.volume_cbm} CBM</span></td><td><span className={`status ${statusTone(quote.lifecycle_status)}`}>{statusLabel(quote.lifecycle_status)}</span></td><td>{quote.order_id ? <Link className="order-id" to={`/admin/orders/${quote.order_id}`}>{quote.order_number}</Link> : <span className="subline">尚未生成</span>}</td><td><QuoteActions quote={quote} busy={busy} /></td></tr>)}
      </tbody></table></div>
      {!loaderData.quotes.length && <div className="empty-state">暂无符合条件的报价。</div>}
    </section>
  </div>;
}

function QuoteActions({ quote, busy }: { quote: Quote; busy: boolean }) {
  return <div className="toolbar-actions quotation-table-actions">
    <Modal title={`报价详情 · ${quote.quote_number}`} triggerLabel="查看" triggerClassName="btn"><QuoteDetail quote={quote} /></Modal>
    {quote.lifecycle_status === "pending" && <Form method="post"><input type="hidden" name="intent" value="accept"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy}>代客户确认</button></Form>}
    {quote.lifecycle_status === "accepted" && quote.order_status === "draft" && <Form method="post"><input type="hidden" name="intent" value="withdraw"/><input type="hidden" name="id" value={quote.id}/><button className="btn" disabled={busy}>撤回接受</button></Form>}
    {quote.lifecycle_status === "withdrawn" && <Form method="post"><input type="hidden" name="intent" value="accept"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy}>重新接受</button></Form>}
    {["pending", "withdrawn"].includes(quote.lifecycle_status) && <Form method="post"><input type="hidden" name="intent" value="void"/><input type="hidden" name="id" value={quote.id}/><button className="btn danger" disabled={busy}>作废</button></Form>}
  </div>;
}

function QuoteDetail({ quote }: { quote: Quote }) {
  return <div className="drawer-grid quote-detail-grid">
    <ReadCell label="客户" value={quote.customer_name}/><ReadCell label="业务员" value={quote.salesperson_name || "—"}/>
    <ReadCell label="客户联系人" value={quote.customer_contact_name || "—"}/><ReadCell label="联系电话" value={quote.customer_contact_phone || "—"}/>
    <ReadCell label="运输方案" value={`汽运 · ${quote.road_load_type === "ltl" ? "拼车" : "整车"}`}/><ReadCell label="清关责任" value={quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}/>
    <ReadCell label="提货地址" value={quote.pickup_address || "—"}/><ReadCell label="目的仓" value={quote.destination_warehouse_name || "—"}/>
    <ReadCell label="线路" value={`${quote.origin_country} ${quote.origin_state || ""} ${quote.origin_city} → ${quote.destination_country} ${quote.destination_state || ""} ${quote.destination_city}`}/><ReadCell label="目的仓备注" value={quote.destination_warehouse_note || "—"}/>
    <ReadCell label="货物" value={quote.cargo_description}/><ReadCell label="预计件重体" value={`${quote.pieces} 件 · ${quote.gross_weight_kg} KG · ${quote.volume_cbm} CBM`}/>
    <ReadCell label="预计长宽高" value={`${quote.estimated_length_cm} × ${quote.estimated_width_cm} × ${quote.estimated_height_cm} CM`}/><ReadCell label="应收总额" value={`CNY ${quote.total_amount.toLocaleString()}`}/>
  </div>;
}

function ReadCell({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><b>{value}</b></div>;
}

function QuoteForm({ loaderData, busy }: { loaderData: Awaited<ReturnType<typeof loader>>; busy: boolean }) {
  const [customerId, setCustomerId] = useState(loaderData.customers[0]?.id || "");
  const [pickupAddress, setPickupAddress] = useState(loaderData.customers[0]?.pickup_address || "");
  const [customerContactName, setCustomerContactName] = useState(loaderData.customers[0]?.contact_name || "");
  const [customerContactPhone, setCustomerContactPhone] = useState(loaderData.customers[0]?.contact_phone || "");
  const [pieces, setPieces] = useState("1");
  const [lengthCm, setLengthCm] = useState("");
  const [widthCm, setWidthCm] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [charges, setCharges] = useState([{ name: transportChargeNameOptions[0]?.[0] || "国际汽运费", quantity: 1, unitPrice: 0, notes: "" }]);
  const total = charges.reduce((sum, charge) => sum + Number(charge.quantity || 0) * Number(charge.unitPrice || 0), 0);
  const calculatedVolume = [pieces, lengthCm, widthCm, heightCm].every((value) => Number(value) > 0)
    ? (Number(pieces) * Number(lengthCm) * Number(widthCm) * Number(heightCm) / 1_000_000).toFixed(4)
    : "";
  const selectedCustomerContacts = loaderData.contacts.filter((contact) => contact.customer_id === customerId);
  const selectedCustomer = loaderData.customers.find((customer) => customer.id === customerId);
  const selectCustomer = (id: string) => {
    setCustomerId(id);
    const customer = loaderData.customers.find((item) => item.id === id);
    setPickupAddress(customer?.pickup_address || "");
    setCustomerContactName(customer?.contact_name || "");
    setCustomerContactPhone(customer?.contact_phone || "");
  };
  return <Form method="post" className="prototype-quote-form">
    <input type="hidden" name="intent" value="create"/>
    <div className="quote-form-note">必填项只有在未填写时显示红色标记；报价被接受后，表内数据自动继承到运输订单。</div>
    <div className="quote-ledger">
    <QuoteLedgerSection className="quote-plan-section" title="客户与运输方案" note="报价确认后不再重复创建订单">
      <div className="quote-field-grid quote-plan-grid">
        <Field label="客户"><select className="control" name="customerId" value={customerId} onChange={(event) => selectCustomer(event.target.value)} required><option value="">请选择客户</option>{loaderData.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field>
        <Field label="客户联系人"><ContactCombobox name="customerContactName" value={customerContactName} contacts={selectedCustomerContacts} mode="name" onChange={(value, contact) => { setCustomerContactName(value); if (contact?.phone) setCustomerContactPhone(contact.phone); }} /></Field>
        <Field label="联系电话"><ContactCombobox name="customerContactPhone" value={customerContactPhone} contacts={selectedCustomerContacts} mode="phone" onChange={(value, contact) => { setCustomerContactPhone(value); if (contact) setCustomerContactName(contact.name); }} /></Field>
        <Field label="业务员"><select className="control" name="salespersonId" defaultValue={loaderData.current.userId} required><option value="">请选择业务员</option>{loaderData.users.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}</select></Field>
        <Field label="运输方式"><select className="control" name="transportMode" defaultValue="ROAD" required><option value="ROAD">汽运</option><option value="RAIL" disabled>铁运（流程未开放）</option><option value="AIR" disabled>空运（流程未开放）</option></select></Field>
        <Field label="订单类型"><select className="control" name="roadLoadType" defaultValue="ltl" required><option value="ltl">拼车</option><option value="ftl">整车</option></select></Field>
        <Field label="清关办理方式"><select className="control" name="customsClearanceMode" defaultValue="company" required><option value="company">公司代办清关</option><option value="customer">客户自理清关</option></select></Field>
      </div>
    </QuoteLedgerSection>
    <QuoteLedgerSection className="quote-route-section" title="运输路线" note="点击地区后按国家 / 地区 → 省 / 州 → 城市逐级展开">
      <div className="quote-route-compare">
        <section className="quote-route-group" aria-labelledby="quote-origin-heading">
          <header className="quote-route-group-title"><b id="quote-origin-heading">起运</b><span>客户提货信息</span></header>
          <div className="quote-route-group-body">
            <GeoCascadeFields key={`origin-${customerId}`} prefix="origin" countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities} initialCountry={selectedCustomer?.pickup_country_code} initialProvince={selectedCustomer?.pickup_state_code} initialCity={selectedCustomer?.pickup_city} />
            <Field label="提货地址" className="quote-route-address"><textarea className="control textarea" name="pickupAddress" rows={2} value={pickupAddress} onChange={(event) => setPickupAddress(event.target.value)} required /></Field>
          </div>
        </section>
        <section className="quote-route-group" aria-labelledby="quote-destination-heading">
          <header className="quote-route-group-title"><b id="quote-destination-heading">目的地</b><span>境外目的仓信息</span></header>
          <div className="quote-route-group-body">
            <GeoCascadeFields prefix="destination" countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities} />
            <Field label="目的仓库" className="quote-route-warehouse"><select className="control quote-warehouse-select" name="destinationWarehouseId" required><option value="">请选择境外目的仓</option>{loaderData.warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></Field>
            <Field label="报价目的地备注" className="quote-route-note"><textarea className="control textarea" name="destinationWarehouseNote" rows={2} /></Field>
          </div>
        </section>
      </div>
    </QuoteLedgerSection>
    <QuoteLedgerSection title="货物预估与报价说明" note="货物数据为预估值，仓库收货后登记实际数据">
      <div className="quote-description-grid">
        <Field label="货物描述"><textarea className="control textarea" name="cargoDescription" rows={3} placeholder="填写货物名称、品类、材质、用途等说明" required /></Field>
        <Field label="报价备注"><textarea className="control textarea" name="notes" rows={3} placeholder="填写报价范围、特殊约定或其他说明" /></Field>
      </div>
      <div className="quote-cargo-grid">
        <div className="table-wrap quote-cargo-metrics-table"><table className="inline-table"><thead><tr><th>预计件数</th><th>预计重量 KG</th><th>预计长度 CM</th><th>预计宽度 CM</th><th>预计高度 CM</th><th>预计体积 CBM（自动计算）</th></tr></thead><tbody><tr>
          <td><input aria-label="预计件数" className="control" name="pieces" type="number" min="1" value={pieces} onChange={(event) => setPieces(event.target.value)} required/></td>
          <td><input aria-label="预计重量 KG" className="control" name="weight" type="number" min="0.001" step="0.001" required/></td>
          <td><input aria-label="预计长度 CM" className="control" name="length" type="number" min="0.01" step="0.01" value={lengthCm} onChange={(event) => setLengthCm(event.target.value)} required/></td>
          <td><input aria-label="预计宽度 CM" className="control" name="width" type="number" min="0.01" step="0.01" value={widthCm} onChange={(event) => setWidthCm(event.target.value)} required/></td>
          <td><input aria-label="预计高度 CM" className="control" name="height" type="number" min="0.01" step="0.01" value={heightCm} onChange={(event) => setHeightCm(event.target.value)} required/></td>
          <td><input aria-label="预计体积 CBM" className="control quote-calculated-volume" name="volume" type="number" min="0.0001" step="0.0001" value={calculatedVolume} readOnly required/></td>
        </tr></tbody></table></div>
      </div>
    </QuoteLedgerSection>
    <QuoteLedgerSection
      title="客户应收费用"
      note="接受后直接继承到订单结算"
      action={<button className="btn quote-charge-add" type="button" onClick={() => setCharges((rows) => [...rows, { name: transportChargeNameOptions[0]?.[0] || "国际汽运费", quantity: 1, unitPrice: 0, notes: "" }])}>＋ 添加费用</button>}
    >
      <div className="table-wrap quote-charge-table-wrap"><table className="inline-table quote-charge-table"><thead><tr><th>费用名称</th><th>数量</th><th>单价</th><th>金额</th><th>备注</th><th>操作</th></tr></thead><tbody>{charges.map((charge, index) => <tr key={index}><td><select className="control" name="chargeName" value={charge.name} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} required>{transportChargeNameOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><input className="control" name="chargeQuantity" type="number" min="0.01" step="0.01" value={charge.quantity} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: Number(event.target.value) } : row))} required/></td><td><input className="control" name="chargeUnitPrice" type="number" min="0.01" step="0.01" value={charge.unitPrice} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, unitPrice: Number(event.target.value) } : row))} required/></td><td><b>{(charge.quantity * charge.unitPrice).toLocaleString()}</b></td><td><input className="control" name="chargeNotes" value={charge.notes} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, notes: event.target.value } : row))}/></td><td><button className="btn danger" type="button" disabled={charges.length === 1} onClick={() => setCharges((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>删除</button></td></tr>)}</tbody></table></div>
      <div className="quote-charge-summary"><small>共 {charges.length} 个费用项目，系统按“数量 × 单价”自动汇总</small><strong>报价总额 CNY {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
      <div className="quote-validity-row"><Field label="报价有效期"><input className="control" name="validUntil" type="date"/></Field></div>
    </QuoteLedgerSection>
    </div>
    <div className="modal-form-actions"><button className="btn primary large" disabled={busy}>保存报价并等待客户确认</button></div>
  </Form>;
}

function QuoteLedgerSection({ title, note, action, className = "", children }: { title: string; note: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <section className={`quote-ledger-section ${className}`}><div className="quote-ledger-heading"><b>{title}</b><div className="quote-section-heading"><span>{note}</span>{action}</div></div><div className="quote-ledger-body">{children}</div></section>;
}

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}

function ContactCombobox({
  name,
  value,
  contacts,
  mode,
  onChange,
}: {
  name: string;
  value: string;
  contacts: CustomerContactOption[];
  mode: "name" | "phone";
  onChange: (value: string, contact?: CustomerContactOption) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `quote-${name}-options`;
  const selectableContacts = contacts.filter((contact) => mode === "name" || Boolean(contact.phone));
  const findContact = (nextValue: string) => selectableContacts.find((contact) => (
    mode === "name" ? contact.name === nextValue : contact.phone === nextValue
  ));
  return <div className="quote-contact-combobox">
    <input
      ref={inputRef}
      className="control"
      name={name}
      type={mode === "phone" ? "tel" : "text"}
      list={listId}
      value={value}
      placeholder={mode === "name" ? "选择或输入联系人" : "选择或输入联系电话"}
      onChange={(event) => onChange(event.target.value, findContact(event.target.value))}
      required
    />
    <button
      type="button"
      title={contacts.length ? "展开客户联系人" : "该客户暂无联系人，可直接输入"}
      aria-label={contacts.length ? "展开客户联系人" : "该客户暂无联系人，可直接输入"}
      onClick={() => {
        inputRef.current?.focus();
        try {
          inputRef.current?.showPicker?.();
        } catch {
          // Some browsers expose showPicker but do not allow it for text inputs.
        }
      }}
    ><ChevronDown aria-hidden="true" size={14}/></button>
    <datalist id={listId}>
      {selectableContacts.map((contact) => <option key={`${name}-${contact.id}`} value={mode === "name" ? contact.name : contact.phone || ""}>{mode === "name" ? contact.phone || "未登记电话" : contact.name}{contact.is_primary ? " · 主要联系人" : ""}</option>)}
    </datalist>
  </div>;
}

function GeoCascadeFields({
  prefix,
  countries,
  provinces,
  cities,
  initialCountry = "",
  initialProvince = "",
  initialCity = "",
}: {
  prefix: "origin" | "destination";
  countries: GeoOption[];
  provinces: GeoOption[];
  cities: GeoOption[];
  initialCountry?: string | null;
  initialProvince?: string | null;
  initialCity?: string | null;
}) {
  const initialCountryCode = countries.find((option) => option.code === initialCountry || option.name === initialCountry)?.code || "";
  const initialProvinceCode = provinces.find((option) => option.parent_code === initialCountryCode && (option.code === initialProvince || option.name === initialProvince))?.code || "";
  const initialCityCode = cities.find((option) => option.parent_code === initialProvinceCode && (option.code === initialCity || option.name === initialCity))?.code || "";
  const [countryCode, setCountryCode] = useState(initialCountryCode);
  const [provinceCode, setProvinceCode] = useState(initialProvinceCode);
  const [cityCode, setCityCode] = useState(initialCityCode);
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const countryOptions = countries;
  const provinceOptions = provinces.filter((option) => option.parent_code === countryCode);
  const cityOptions = cities.filter((option) => option.parent_code === provinceCode);
  const countryName = countries.find((option) => option.code === countryCode)?.name || "";
  const provinceName = provinces.find((option) => option.code === provinceCode)?.name || "";
  const cityName = cities.find((option) => option.code === cityCode)?.name || "";
  const placeLabel = prefix === "origin" ? "起运" : "目的";
  const selectionLabel = [countryName, provinceName, cityName].filter(Boolean).join(" / ");
  const panelId = `${prefix}-geo-cascade`;

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return <div ref={pickerRef} className={`quote-geo-picker ${cityCode ? "is-complete" : "is-incomplete"} ${isOpen ? "is-open" : ""}`}>
    <button
      aria-controls={panelId}
      aria-expanded={isOpen}
      className="quote-geo-trigger"
      type="button"
      onClick={() => setIsOpen((current) => !current)}
    >
      <span className="quote-geo-trigger-label">{placeLabel}地区</span>
      <b>{selectionLabel || "请选择国家 / 地区"}</b>
      <ChevronDown aria-hidden="true" size={14}/>
    </button>
    {isOpen && <div className="quote-geo-cascade" id={panelId} role="group" aria-label={`选择${placeLabel}地区`}>
      <GeoCascadePanel
        title="1  国家 / 地区"
        options={countryOptions}
        activeValue={countryCode}
        emptyText="暂无国家 / 地区数据"
        showNext
        onSelect={(option) => {
          setCountryCode(option.code);
          setProvinceCode("");
          setCityCode("");
        }}
      />
      {countryCode && <GeoCascadePanel
        title="2  省 / 州"
        options={provinceOptions}
        activeValue={provinceCode}
        emptyText="该国家暂无省 / 州数据"
        showNext
        onSelect={(option) => {
          setProvinceCode(option.code);
          setCityCode("");
        }}
      />}
      {provinceCode && <GeoCascadePanel
        title="3  城市"
        options={cityOptions}
        activeValue={cityCode}
        emptyText="该省 / 州暂无城市数据"
        onSelect={(option) => {
          setCityCode(option.code);
          setIsOpen(false);
        }}
      />}
    </div>}
    <select
      aria-label={`${placeLabel}国家 / 地区校验`}
      className="quote-geo-native-validator"
      name={`${prefix}Country`}
      value={countryName}
      onChange={() => undefined}
      onInvalid={() => setIsOpen(true)}
      required
      tabIndex={-1}
    ><option value=""/>{countryName && <option value={countryName}>{countryName}</option>}</select>
    <select
      aria-label={`${placeLabel}省 / 州校验`}
      className="quote-geo-native-validator"
      name={`${prefix}State`}
      value={provinceName}
      onChange={() => undefined}
      onInvalid={() => setIsOpen(true)}
      required
      tabIndex={-1}
    ><option value=""/>{provinceName && <option value={provinceName}>{provinceName}</option>}</select>
    <select
      aria-label={`${placeLabel}城市校验`}
      className="quote-geo-native-validator"
      name={`${prefix}City`}
      value={cityName}
      onChange={() => undefined}
      onInvalid={() => setIsOpen(true)}
      required
      tabIndex={-1}
    ><option value=""/>{cityName && <option value={cityName}>{cityName}</option>}</select>
  </div>;
}

function GeoCascadePanel({
  title,
  options,
  activeValue,
  emptyText,
  showNext = false,
  onSelect,
}: {
  title: string;
  options: GeoOption[];
  activeValue: string;
  emptyText: string;
  showNext?: boolean;
  onSelect: (option: GeoOption) => void;
}) {
  return <section className="quote-geo-panel">
    <header>{title}</header>
    {options.length > 0
      ? <div className="quote-geo-panel-options" role="listbox" aria-label={title}>{options.map((option) => <button
          aria-selected={activeValue === option.code}
          className={activeValue === option.code ? "selected" : ""}
          key={`${title}-${option.code}`}
          role="option"
          type="button"
          onClick={() => onSelect(option)}
        ><span>{option.name}</span>{showNext && <ChevronRight aria-hidden="true" size={13}/>}</button>)}</div>
      : <p>{emptyText}</p>}
  </section>;
}

async function geoOptions(organizationId: string, level: string) {
  return (await env.DB.prepare(
    "SELECT code,name,parent_code FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,name",
  ).bind(organizationId,level).all<GeoOption>()).results ?? [];
}

async function assertGeoHierarchy(organizationId: string, countryName: string, provinceName: string, cityName: string, label: string) {
  const row = await env.DB.prepare(
    `SELECT city.code
     FROM reference_data country
     JOIN reference_data province
       ON province.organization_id=country.organization_id
      AND province.category='province'
      AND province.parent_code=country.code
      AND province.status='active'
     JOIN reference_data city
       ON city.organization_id=province.organization_id
      AND city.category='city'
      AND city.parent_code=province.code
      AND city.status='active'
     WHERE country.organization_id=?
       AND country.category='country'
       AND country.status='active'
       AND country.name=?
       AND province.name=?
       AND city.name=?
     LIMIT 1`,
  ).bind(organizationId, countryName, provinceName, cityName).first();
  if (!row) throw new Error(`${label}的国家、省州和城市不属于同一条地理层级，请重新选择`);
}

function statusLabel(status: Quote["lifecycle_status"]) {
  return { pending: "待客户确认", accepted: "客户已接受", withdrawn: "接受已撤回", void: "已作废" }[status];
}

function statusTone(status: Quote["lifecycle_status"]) {
  if (status === "accepted") return "green";
  if (status === "pending") return "orange";
  if (status === "void") return "red";
  return "blue";
}

export function meta() { return [{ title: "询价与报价 | 新翎航 TMS" }]; }
