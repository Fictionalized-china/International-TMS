import { env } from "cloudflare:workers";
import { useMemo, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
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
import { valueOf } from "../lib/validation";

type Quote = {
  id: string;
  quote_number: string;
  customer_name: string;
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
  const [quotes, customers, users, warehouses, countries, provinces, cities] = await Promise.all([
    env.DB.prepare(
      `SELECT q.id,q.quote_number,c.name customer_name,u.display_name salesperson_name,
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
        (SELECT a.address_line1 FROM customer_addresses a WHERE a.customer_id=c.id ORDER BY a.is_default DESC,a.created_at LIMIT 1) pickup_address
       FROM customers c WHERE c.organization_id=? AND c.status='active' ORDER BY c.name`,
    ).bind(current.organizationId).all<CustomerOption>(),
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
      const pieces = positiveInteger(valueOf(form, "pieces"), "预计件数");
      const weight = positiveNumber(valueOf(form, "weight"), "预计重量");
      const length = positiveNumber(valueOf(form, "length"), "预计长度");
      const width = positiveNumber(valueOf(form, "width"), "预计宽度");
      const height = positiveNumber(valueOf(form, "height"), "预计高度");
      const volume = positiveNumber(valueOf(form, "volume"), "预计体积");
      const validUntil = valueOf(form, "validUntil");
      const notes = valueOf(form, "notes");
      if (!customerId || !salespersonId || transportMode !== "ROAD" || !["ftl", "ltl"].includes(roadLoadType)) {
        throw new Error("请选择客户、业务员、汽运和整车/拼车类型");
      }
      if (![pickupAddress, originCountry, originState, originCity, destinationCountry, destinationState, destinationCity, destinationWarehouseId, cargoDescription].every(Boolean)) {
        throw new Error("请完整填写提货地址、起运地、目的地、目的仓和货物描述");
      }
      if (!["company", "customer"].includes(customsClearanceMode)) throw new Error("请选择清关办理方式");
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
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
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
      <div className="head-actions"><Modal title="创建运输报价" triggerLabel="创建报价" triggerClassName="btn primary" closeSignal={actionData?.success} size="wide"><QuoteForm loaderData={loaderData} busy={busy} /></Modal></div>
    </div>
    {(actionData?.success || actionData?.formError) && <div className={`gate ${actionData.formError ? "" : "ok"}`}>{actionData.formError || actionData.success}</div>}
    <div className="kpis quotation-kpis">
      <div className="panel"><span>待客户确认</span><b>{stats.pending}</b></div>
      <div className="panel"><span>已接受</span><b>{stats.accepted}</b></div>
      <div className="panel"><span>自动生成订单</span><b>{stats.orders}</b></div>
      <div className="panel"><span>规则</span><b>一报一单</b></div>
    </div>
    <Form className="panel filters quotation-filters" method="get">
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
  return <div className="toolbar-actions">
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
  const [charges, setCharges] = useState([{ name: transportChargeNameOptions[0]?.[0] || "国际汽运费", quantity: 1, unitPrice: 0, notes: "" }]);
  const total = charges.reduce((sum, charge) => sum + Number(charge.quantity || 0) * Number(charge.unitPrice || 0), 0);
  const selectCustomer = (id: string) => {
    setCustomerId(id);
    setPickupAddress(loaderData.customers.find((customer) => customer.id === id)?.pickup_address || "");
  };
  return <Form method="post" className="prototype-quote-form">
    <input type="hidden" name="intent" value="create"/>
    <div className="gate ok">带 * 的字段会在报价被接受后自动继承到运输订单，运输类型随即锁定。</div>
    <FormSection title="客户与运输方案" note="报价确认后不再重复创建订单">
      <div className="grid">
        <Field label="客户 *"><select className="control filled" name="customerId" value={customerId} onChange={(event) => selectCustomer(event.target.value)} required><option value="">请选择客户</option>{loaderData.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field>
        <Field label="业务员 *"><select className="control filled" name="salespersonId" required><option value="">请选择业务员</option>{loaderData.users.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}</select></Field>
        <Field label="运输方式 *"><select className="control filled" name="transportMode" defaultValue="ROAD"><option value="ROAD">汽运</option><option value="RAIL" disabled>铁运（流程未开放）</option><option value="AIR" disabled>空运（流程未开放）</option></select></Field>
        <Field label="订单类型 *"><select className="control filled" name="roadLoadType" defaultValue="ltl"><option value="ltl">拼车</option><option value="ftl">整车</option></select></Field>
        <Field label="清关办理方式 *"><select className="control filled" name="customsClearanceMode" defaultValue="company"><option value="company">公司代办清关</option><option value="customer">客户自理清关</option></select></Field>
      </div>
    </FormSection>
    <FormSection title="起运地与目的地" note="最终目的地为境外目的仓，客户到仓自提">
      <div className="grid">
        <Field label="起运国家 / 地区 *"><GeoSelect name="originCountry" options={loaderData.countries}/></Field>
        <Field label="起运省 / 州 *"><GeoSelect name="originState" options={loaderData.provinces}/></Field>
        <Field label="起运城市 *"><GeoSelect name="originCity" options={loaderData.cities}/></Field>
        <Field label="目的国家 / 地区 *"><GeoSelect name="destinationCountry" options={loaderData.countries}/></Field>
        <Field label="目的省 / 州 *"><GeoSelect name="destinationState" options={loaderData.provinces}/></Field>
        <Field label="目的城市 *"><GeoSelect name="destinationCity" options={loaderData.cities}/></Field>
        <Field label="目的仓库 *"><select className="control filled" name="destinationWarehouseId" required><option value="">请选择境外目的仓</option>{loaderData.warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></Field>
        <Field label="提货地址 *" className="span2"><textarea className="control textarea editing" name="pickupAddress" value={pickupAddress} onChange={(event) => setPickupAddress(event.target.value)} required /></Field>
        <Field label="报价目的地备注" className="span2"><textarea className="control textarea" name="destinationWarehouseNote" /></Field>
      </div>
    </FormSection>
    <FormSection title="货物预估数据" note="仓库实收后登记实际数据">
      <div className="grid">
        <Field label="货物描述 *" className="span4"><textarea className="control textarea editing" name="cargoDescription" required /></Field>
        <Field label="预计件数 *"><input className="control filled" name="pieces" type="number" min="1" defaultValue="1" required/></Field>
        <Field label="预计重量 KG *"><input className="control filled" name="weight" type="number" min="0.001" step="0.001" required/></Field>
        <Field label="预计长度 CM *"><input className="control filled" name="length" type="number" min="0.01" step="0.01" required/></Field>
        <Field label="预计宽度 CM *"><input className="control filled" name="width" type="number" min="0.01" step="0.01" required/></Field>
        <Field label="预计高度 CM *"><input className="control filled" name="height" type="number" min="0.01" step="0.01" required/></Field>
        <Field label="预计体积 CBM *"><input className="control filled" name="volume" type="number" min="0.001" step="0.001" required/></Field>
      </div>
    </FormSection>
    <FormSection title="客户应收费用" note="接受后直接继承到订单结算">
      <table className="inline-table quote-charge-table"><thead><tr><th>费用名称 *</th><th>数量 *</th><th>单价 *</th><th>金额</th><th>备注</th><th>操作</th></tr></thead><tbody>{charges.map((charge, index) => <tr key={index}><td><select className="control filled" name="chargeName" value={charge.name} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))}>{transportChargeNameOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><input className="control filled" name="chargeQuantity" type="number" min="0.01" step="0.01" value={charge.quantity} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: Number(event.target.value) } : row))}/></td><td><input className="control filled" name="chargeUnitPrice" type="number" min="0" step="0.01" value={charge.unitPrice} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, unitPrice: Number(event.target.value) } : row))}/></td><td><b>{(charge.quantity * charge.unitPrice).toLocaleString()}</b></td><td><input className="control" name="chargeNotes" value={charge.notes} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, notes: event.target.value } : row))}/></td><td><button className="btn danger" type="button" disabled={charges.length === 1} onClick={() => setCharges((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>删除</button></td></tr>)}</tbody></table>
      <div className="quote-charge-actions"><button className="btn" type="button" onClick={() => setCharges((rows) => [...rows, { name: transportChargeNameOptions[0]?.[0] || "国际汽运费", quantity: 1, unitPrice: 0, notes: "" }])}>新增费用</button><strong>报价总额 CNY {total.toLocaleString()}</strong></div>
      <div className="grid two"><Field label="报价有效期"><input className="control" name="validUntil" type="date"/></Field><Field label="报价备注"><textarea className="control textarea" name="notes"/></Field></div>
    </FormSection>
    <div className="modal-form-actions"><button className="btn primary large" disabled={busy}>保存报价并等待客户确认</button></div>
  </Form>;
}

function FormSection({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return <section className="section"><div className="section-title"><b>{title}</b><span>{note}</span></div>{children}</section>;
}

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}

function GeoSelect({ name, options = [] }: { name: string; options?: GeoOption[] }) {
  return <select className="control filled" name={name} required><option value="">请选择</option>{options.map((option) => <option key={`${name}-${option.code}`} value={option.name}>{option.name}</option>)}</select>;
}

function positiveNumber(value: string, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

function positiveInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是大于 0 的整数`);
  return number;
}

async function geoOptions(organizationId: string, level: string) {
  return (await env.DB.prepare(
    "SELECT code,name,parent_code FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,name",
  ).bind(organizationId,level).all<GeoOption>()).results ?? [];
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
