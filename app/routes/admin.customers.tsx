import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/admin.customers";
import { requireSessionUser } from "../lib/auth.server";
import { hashPassword } from "../lib/crypto.server";
import { validateCode, validateEmail, validatePassword, validatePhone, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { CustomerEditorForm } from "../components/CustomerEditorForm";
import { generateCustomerIdentityCode } from "../lib/customer-identity";
import { resolveCustomerCode } from "../lib/customer-code";
import {
  customerBusinessRoleLabel,
  customerBusinessRoles,
  isCustomerBusinessRoleCode,
  legacyCustomerTypeForRoles,
  type CustomerBusinessRoleCode,
} from "../lib/customer-business-roles";
import {
  canViewAllCustomers,
  customerVisibilitySql,
  requireCustomerAccess,
} from "../lib/customer-access.server";
import { describeCustomerAccess } from "../lib/customer-access-view";

const customerPartyCategories = [
  { value: "customer", label: "客户" },
  { value: "supplier", label: "供应商" },
  { value: "both", label: "客户&供应商" },
] as const;

type CustomerPartyCategory = (typeof customerPartyCategories)[number]["value"];
const customerPartyCategorySet = new Set<string>(customerPartyCategories.map((item) => item.value));

function isCustomerPartyCategory(value: string): value is CustomerPartyCategory {
  return customerPartyCategorySet.has(value);
}

function customerPartyCategoryLabel(value: string) {
  return customerPartyCategories.find((item) => item.value === value)?.label ?? value;
}

type CustomerRow = {
  id: string;
  code: string;
  identity_code: string;
  name: string;
  short_name: string | null;
  party_category: CustomerPartyCategory;
  status: string;
  notes: string | null;
  sales_owner_user_id: string | null;
  sales_owner_name: string | null;
  business_role_codes: string;
  contact_count: number;
  address_count: number;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  primary_contact_title: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  default_address_id: string | null;
  default_address_country_code: string | null;
  default_address_state: string | null;
  default_address_city: string | null;
  default_address_line1: string | null;
};
type ContactRow = { id: string; customer_id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: number };
type AddressRow = { id: string; customer_id: string; label: string; type: string; country_code: string; state: string | null; city: string; address_line1: string; contact_name: string | null; contact_phone: string | null; is_default: number };
type PortalRow = { id: string; customer_id: string; user_id: string; display_name: string; email: string; status: string; last_login_at: string | null };
type PortalRegistrationRow = { id: string; user_id: string; company_name: string; customer_identity_code: string | null; contact_name: string; contact_phone: string | null; email: string; candidate_customer_id: string | null; candidate_customer_name: string | null; created_at: string };
type ContractRow = { id: string; customer_id: string; title: string; file_name: string; content_type: string; size_bytes: number; effective_at: string | null; expires_at: string | null; status: string; notes: string | null; created_at: string };
type GeoReference = { code: string; name: string; parent_code: string | null };
type CustomerDefaultProfile = {
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  contactPhone: string;
  addressCountryCode: string;
  addressState: string;
  addressCity: string;
  addressLine1: string;
};

function customerDefaultProfile(form: FormData): CustomerDefaultProfile {
  return {
    contactName: valueOf(form, "contactName"),
    contactTitle: valueOf(form, "contactTitle"),
    contactEmail: valueOf(form, "contactEmail").toLowerCase(),
    contactPhone: valueOf(form, "contactPhone"),
    addressCountryCode: valueOf(form, "addressCountryCode"),
    addressState: valueOf(form, "addressState"),
    addressCity: valueOf(form, "addressCity"),
    addressLine1: valueOf(form, "addressLine1"),
  };
}

async function validateCustomerDefaultProfile(profile: CustomerDefaultProfile, organizationId: string) {
  if (profile.contactName.length < 2) return "默认联系人姓名至少 2 个字符";
  if (profile.contactTitle.length > 80) return "联系人职务不能超过 80 个字符";
  if (profile.contactEmail && validateEmail(profile.contactEmail)) return "联系人邮箱格式不正确";
  const phoneError = validatePhone(profile.contactPhone, "默认联系人电话");
  if (phoneError) return phoneError;
  if (!profile.addressCountryCode || !profile.addressState || !profile.addressCity || !profile.addressLine1)
    return "请完整选择默认提货地址的国家、省州和城市，并填写详细地址";
  const [province, city] = await Promise.all([
    env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='province' AND code=? AND parent_code=? AND status='active'")
      .bind(organizationId, profile.addressState, profile.addressCountryCode).first(),
    env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='city' AND name=? AND parent_code=? AND status='active'")
      .bind(organizationId, profile.addressCity, profile.addressState).first(),
  ]);
  return province && city ? null : "默认提货地址的国家、省州和城市不匹配";
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "customer.view");
  const visibility = customerVisibilitySql(current, "c");
  const customerAccess = describeCustomerAccess(current);
  const canViewSensitive = current.permissions.includes("customer.sensitive.view");
  const [customers, contacts, addresses, portals] = await Promise.all([
    env.DB.prepare(`SELECT c.id, c.code, c.identity_code, c.name, c.short_name, COALESCE(c.party_category,'customer') AS party_category, c.status, c.notes, c.sales_owner_user_id, u.display_name AS sales_owner_name, COALESCE(GROUP_CONCAT(DISTINCT cbr.role_code), '') AS business_role_codes, COUNT(DISTINCT cc.id) AS contact_count, COUNT(DISTINCT ca.id) AS address_count,
      (SELECT x.id FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_id,
      (SELECT x.name FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_name,
      (SELECT x.title FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_title,
      (SELECT x.email FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_email,
      (SELECT x.phone FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_phone,
      (SELECT x.id FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_id,
      (SELECT x.country_code FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_country_code,
      (SELECT x.state FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_state,
      (SELECT x.city FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_city,
      (SELECT x.address_line1 FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_line1
      FROM customers c LEFT JOIN users u ON u.id = c.sales_owner_user_id LEFT JOIN customer_contacts cc ON cc.customer_id = c.id LEFT JOIN customer_addresses ca ON ca.customer_id = c.id LEFT JOIN customer_business_role_assignments cbr ON cbr.customer_id = c.id AND cbr.organization_id = c.organization_id WHERE c.organization_id = ? AND ${visibility.sql} GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`).bind(current.organizationId,...visibility.values).all<CustomerRow>(),
    env.DB.prepare(`SELECT cc.id, cc.customer_id, cc.name, cc.title, cc.email, cc.phone, cc.is_primary FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id WHERE c.organization_id = ? AND cc.customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY cc.is_primary DESC, cc.name`).bind(current.organizationId,current.organizationId).all<ContactRow>(),
    env.DB.prepare(`SELECT ca.id, ca.customer_id, ca.label, ca.type, ca.country_code, ca.state, ca.city, ca.address_line1, ca.contact_name, ca.contact_phone, ca.is_default FROM customer_addresses ca JOIN customers c ON c.id = ca.customer_id WHERE c.organization_id = ? AND ca.customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY ca.is_default DESC, ca.label`).bind(current.organizationId,current.organizationId).all<AddressRow>(),
    env.DB.prepare(`SELECT cpa.id, cpa.customer_id, cpa.user_id, u.display_name, u.email, cpa.status, u.last_login_at FROM customer_portal_accounts cpa JOIN users u ON u.id = cpa.user_id WHERE cpa.organization_id = ? AND cpa.customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY u.display_name`).bind(current.organizationId,current.organizationId).all<PortalRow>(),
  ]);
  const [registrations, contracts, owners, countries] = await Promise.all([
    env.DB.prepare(`SELECT pr.id,pr.user_id,pr.company_name,pr.customer_identity_code,pr.contact_name,pr.contact_phone,pr.email,pr.candidate_customer_id,c.name candidate_customer_name,pr.created_at FROM portal_registration_requests pr LEFT JOIN customers c ON c.id=pr.candidate_customer_id AND c.organization_id=pr.organization_id WHERE pr.organization_id=? AND pr.status='pending' ORDER BY pr.created_at`).bind(current.organizationId).all<PortalRegistrationRow>(),
    env.DB.prepare(`SELECT id, customer_id, title, file_name, content_type, size_bytes, effective_at, expires_at, status, notes, created_at FROM customer_contracts WHERE organization_id = ? AND customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at DESC LIMIT 500`).bind(current.organizationId,current.organizationId).all<ContractRow>(),
    env.DB.prepare(`SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.status = 'active' ORDER BY u.display_name`).bind(current.organizationId).all<{ id: string; display_name: string }>(),
    env.DB.prepare("SELECT code, name FROM reference_data WHERE organization_id = ? AND category = 'country' AND status = 'active' ORDER BY sort_order, code").bind(current.organizationId).all<{ code: string; name: string }>(),
  ]);
  const [provinces, cities] = await Promise.all([
    env.DB.prepare("SELECT code, name, parent_code FROM reference_data WHERE organization_id = ? AND category = 'province' AND status = 'active' ORDER BY sort_order, code").bind(current.organizationId).all<GeoReference>(),
    env.DB.prepare("SELECT code, name, parent_code FROM reference_data WHERE organization_id = ? AND category = 'city' AND status = 'active' ORDER BY sort_order, code").bind(current.organizationId).all<GeoReference>(),
  ]);
  const visibleCustomerIds = new Set(customers.results.map((customer) => customer.id));
  const visibleCustomers = canViewSensitive ? customers.results : customers.results.map((customer) => ({
    ...customer,
    notes: null,
    contact_count: 0,
    address_count: 0,
    primary_contact_id: null,
    primary_contact_name: null,
    primary_contact_title: null,
    primary_contact_email: null,
    primary_contact_phone: null,
    default_address_id: null,
    default_address_country_code: null,
    default_address_state: null,
    default_address_city: null,
    default_address_line1: null,
  }));
  return {
    current,
    customerAccess,
    customers: visibleCustomers,
    contacts: canViewSensitive ? contacts.results.filter((row) => visibleCustomerIds.has(row.customer_id)) : [],
    addresses: canViewSensitive ? addresses.results.filter((row) => visibleCustomerIds.has(row.customer_id)) : [],
    portals: canViewSensitive ? portals.results.filter((row) => visibleCustomerIds.has(row.customer_id)) : [],
    registrations: canViewSensitive && canViewAllCustomers(current)
      ? registrations.results
      : registrations.results.filter((row) => Boolean(row.candidate_customer_id && visibleCustomerIds.has(row.candidate_customer_id))),
    contracts: canViewSensitive ? contracts.results.filter((row) => visibleCustomerIds.has(row.customer_id)) : [],
    owners: canViewAllCustomers(current) ? owners.results : owners.results.filter((owner) => owner.id === current.userId),
    countries: countries.results,
    provinces: provinces.results,
    cities: cities.results,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "customer.manage");
  if (!current.permissions.includes("customer.sensitive.view")) {
    throw new Response("没有权限查看或修改客户敏感资料", { status: 403 });
  }
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (["portal_registration_approve", "portal_registration_reject"].includes(intent) && !canViewAllCustomers(current)) {
    throw new Response("只有全部客户范围的账号可以审核门户注册", { status: 403 });
  }
  const targetCustomerId = valueOf(form, "customerId");
  if (targetCustomerId) await requireCustomerAccess(current, targetCustomerId);
  if (intent === "contract_archive") {
    const contract = await env.DB.prepare(
      "SELECT customer_id FROM customer_contracts WHERE id=? AND organization_id=?",
    ).bind(valueOf(form, "contractId"), current.organizationId).first<{ customer_id: string }>();
    if (!contract) throw new Response("合同不存在", { status: 404 });
    await requireCustomerAccess(current, contract.customer_id);
  }

  const result = await runCustomerAction({ request, current, form, intent, now });
  return {
    intent,
    customerId: valueOf(form, "customerId") || undefined,
    accountId: valueOf(form, "accountId") || undefined,
    requestId: valueOf(form, "requestId") || undefined,
    contractId: valueOf(form, "contractId") || undefined,
    ...result,
  };
}

async function runCustomerAction({ request, current, form, intent, now }: {
  request: Request;
  current: Awaited<ReturnType<typeof requireSessionUser>>;
  form: FormData;
  intent: string;
  now: string;
}) {

  if (intent === "portal_registration_approve") {
    const requestId = valueOf(form, "requestId"), customerId = valueOf(form, "customerId");
    const [registration, customer, existingPortal] = await Promise.all([
      env.DB.prepare(`SELECT id,user_id,company_name,contact_name,contact_phone,email FROM portal_registration_requests WHERE id=? AND organization_id=? AND status='pending'`).bind(requestId, current.organizationId).first<{ id: string; user_id: string; company_name: string; contact_name: string; contact_phone: string | null; email: string }>(),
      env.DB.prepare(`SELECT id,name,status FROM customers WHERE id=? AND organization_id=? AND status IN ('prospect','active','suspended')`).bind(customerId, current.organizationId).first<{ id: string; name: string; status: string }>(),
      env.DB.prepare(`SELECT id FROM customer_portal_accounts WHERE organization_id=? AND user_id=(SELECT user_id FROM portal_registration_requests WHERE id=? AND organization_id=?)`).bind(current.organizationId, requestId, current.organizationId).first<{ id: string }>(),
    ]);
    if (!registration) return { formError: "注册申请不存在、已处理或已被其他人处理" };
    if (!customer) return { formError: "请选择当前组织内有效的客户档案" };
    if (existingPortal) return { formError: "该注册账号已经绑定客户，请刷新后查看" };
    const accountId = crypto.randomUUID();
    let approvalResults;
    try {
      approvalResults = await env.DB.batch([
        env.DB.prepare(`UPDATE portal_registration_requests SET customer_id=?,status='approved',review_notes=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE id=? AND organization_id=? AND status='pending'`).bind(customer.id, `已绑定客户：${customer.name}`, current.userId, now, now, registration.id, current.organizationId),
        env.DB.prepare(`INSERT INTO customer_portal_accounts(id,organization_id,customer_id,user_id,status,created_at,updated_at) SELECT ?,organization_id,customer_id,user_id,'active',?,? FROM portal_registration_requests WHERE id=? AND organization_id=? AND status='approved' AND reviewed_by_user_id=? AND reviewed_at=?`).bind(accountId, now, now, registration.id, current.organizationId, current.userId, now),
        env.DB.prepare(`INSERT INTO customer_contacts(id,customer_id,name,title,email,phone,is_primary,created_at,updated_at) SELECT ?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM customer_contacts WHERE customer_id=?) THEN 0 ELSE 1 END,?,? WHERE EXISTS(SELECT 1 FROM customer_portal_accounts WHERE id=?) AND NOT EXISTS(SELECT 1 FROM customer_contacts WHERE customer_id=? AND LOWER(COALESCE(email,''))=LOWER(?))`).bind(crypto.randomUUID(), customer.id, registration.contact_name, "客户门户注册联系人", registration.email, registration.contact_phone, customer.id, now, now, accountId, customer.id, registration.email),
        env.DB.prepare(`INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at) SELECT ?,?,?,?,'system',?,?,?,0,? WHERE EXISTS(SELECT 1 FROM customer_portal_accounts WHERE id=?)`).bind(crypto.randomUUID(), current.organizationId, customer.id, registration.user_id, "客户门户账号已开通", `您的账号已经绑定到 ${customer.name}，现在可以查看对应客户的业务资料。`, "/portal/account", now, accountId),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return { formError: "该注册账号已由其他操作绑定，请刷新后查看" };
      throw error;
    }
    if (!approvalResults[0].meta.changes) return { formError: "该注册申请已由其他人处理，请刷新后查看" };
    await writeAudit({ request, action: "portal.registration.approve", resourceType: "portal_registration_request", resourceId: registration.id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId: customer.id, customerName: customer.name, userId: registration.user_id, email: registration.email, accountId } });
    return { success: `已将 ${registration.email} 绑定到客户“${customer.name}”` };
  }

  if (intent === "portal_registration_reject") {
    const requestId = valueOf(form, "requestId"), reviewNotes = valueOf(form, "reviewNotes");
    if (reviewNotes.length < 2 || reviewNotes.length > 240) return { formError: "请填写 2-240 个字符的拒绝原因，便于申请人修正资料" };
    const registration = await env.DB.prepare(`SELECT id,user_id,email FROM portal_registration_requests WHERE id=? AND organization_id=? AND status='pending'`).bind(requestId, current.organizationId).first<{ id: string; user_id: string; email: string }>();
    if (!registration) return { formError: "注册申请不存在、已处理或已被其他人处理" };
    const rejected = await env.DB.prepare(`UPDATE portal_registration_requests SET status='rejected',review_notes=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE id=? AND organization_id=? AND status='pending'`).bind(reviewNotes, current.userId, now, now, registration.id, current.organizationId).run();
    if (!rejected.meta.changes) return { formError: "该注册申请已由其他人处理，请刷新后查看" };
    await writeAudit({ request, action: "portal.registration.reject", resourceType: "portal_registration_request", resourceId: registration.id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { userId: registration.user_id, email: registration.email, reviewNotes } });
    return { success: `已拒绝 ${registration.email} 的注册申请` };
  }

  if (intent === "contact") {
    const customerId = valueOf(form, "customerId"), name = valueOf(form, "name"), title = valueOf(form, "title"), email = valueOf(form, "email").toLowerCase(), phone = valueOf(form, "phone");
    if (!(await ownedCustomer(customerId, current.organizationId))) return { formError: "客户不存在" };
    if (name.length < 2) return { formError: "联系人姓名至少 2 个字符" };
    if (email && validateEmail(email)) return { formError: "联系人邮箱格式不正确" };
    const phoneError = phone ? validatePhone(phone) : undefined;
    if (phoneError) return { formError: phoneError };
    const id = crypto.randomUUID();
    const isPrimary = form.has("isPrimary");
    await env.DB.batch([
      ...(isPrimary ? [env.DB.prepare("UPDATE customer_contacts SET is_primary=0,updated_at=? WHERE customer_id=? AND is_primary=1").bind(now, customerId)] : []),
      env.DB.prepare("INSERT INTO customer_contacts (id, customer_id, name, title, email, phone, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, customerId, name, title || null, email || null, phone || null, isPrimary ? 1 : 0, now, now),
    ]);
    await writeAudit({ request, action: "customer.contact.create", resourceType: "customer_contact", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId } });
    return { success: "联系人已添加" };
  }

  if (intent === "address") {
    const customerId = valueOf(form, "customerId"), label = valueOf(form, "label"), type = valueOf(form, "type"), countryCode = valueOf(form, "countryCode"), city = valueOf(form, "city"), addressLine1 = valueOf(form, "addressLine1");
    if (!(await ownedCustomer(customerId, current.organizationId))) return { formError: "客户不存在" };
    if (!label || !city || !addressLine1) return { formError: "地址名称、城市和详细地址必填" };
    if (!['registered', 'billing', 'shipping', 'warehouse'].includes(type)) return { formError: "地址类型无效" };
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO customer_addresses (id, customer_id, type, label, country_code, city, address_line1, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, customerId, type, label, countryCode || "CN", city, addressLine1, form.has("isDefault") ? 1 : 0, now, now).run();
    await writeAudit({ request, action: "customer.address.create", resourceType: "customer_address", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId } });
    return { success: "地址已添加" };
  }

  if (intent === "pickup_address") {
    const customerId = valueOf(form, "customerId"), label = valueOf(form, "label"), countryCode = valueOf(form, "countryCode"), state = valueOf(form, "state"), city = valueOf(form, "city"), addressLine1 = valueOf(form, "addressLine1"), contactName = valueOf(form, "contactName"), contactPhone = valueOf(form, "contactPhone");
    if (!(await ownedCustomer(customerId, current.organizationId))) return { formError: "客户不存在" };
    if (!label || !countryCode || !state || !city || !addressLine1) return { formError: "请完整填写提货地名称、国家、省州、城市和详细地址" };
    const phoneError = contactPhone ? validatePhone(contactPhone, "提货联系电话") : undefined;
    if (phoneError) return { formError: phoneError };
    const province = await env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='province' AND code=? AND parent_code=? AND status='active'").bind(current.organizationId, state, countryCode).first();
    const cityRow = await env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='city' AND name=? AND parent_code=? AND status='active'").bind(current.organizationId, city, state).first();
    if (!province || !cityRow) return { formError: "请选择国家对应的省/州和城市" };
    const id = crypto.randomUUID();
    if (form.has("isDefault")) await env.DB.prepare("UPDATE customer_addresses SET is_default=0,updated_at=? WHERE customer_id=? AND type='shipping'").bind(now, customerId).run();
    await env.DB.prepare("INSERT INTO customer_addresses (id, customer_id, type, label, country_code, state, city, address_line1, contact_name, contact_phone, is_default, created_at, updated_at) VALUES (?, ?, 'shipping', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, customerId, label, countryCode, state, city, addressLine1, contactName || null, contactPhone || null, form.has("isDefault") ? 1 : 0, now, now).run();
    await writeAudit({ request, action: "customer.pickup_address.create", resourceType: "customer_address", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId } });
    return { success: "常用提货地已保存" };
  }

  if (intent === "portal") {
    const customerId = valueOf(form, "customerId"), displayName = valueOf(form, "displayName"), email = valueOf(form, "email").toLowerCase(), password = valueOf(form, "password");
    if (!(await ownedCustomer(customerId, current.organizationId))) return { formError: "客户不存在" };
    const emailError = validateEmail(email), passwordError = validatePassword(password);
    if (displayName.length < 2 || emailError || passwordError) return { formError: emailError || passwordError || "门户用户姓名至少 2 个字符" };
    if (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first()) return { formError: "该邮箱已被使用" };
    const userId = crypto.randomUUID(), accountId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(userId, email, await hashPassword(password), displayName, now, now),
      env.DB.prepare("INSERT INTO customer_portal_accounts (id, organization_id, customer_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(accountId, current.organizationId, customerId, userId, now, now),
    ]);
    await writeAudit({ request, action: "portal.account.create", resourceType: "customer_portal_account", resourceId: accountId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId, email } });
    return { success: "客户门户账号已开通" };
  }

  if (intent === "portal_password_reset") {
    const customerId = valueOf(form, "customerId"), accountId = valueOf(form, "accountId"), password = valueOf(form, "password"), confirmPassword = valueOf(form, "confirmPassword");
    const account = await env.DB.prepare(
      `SELECT cpa.user_id,u.email
       FROM customer_portal_accounts cpa
       JOIN users u ON u.id=cpa.user_id
       WHERE cpa.id=? AND cpa.customer_id=? AND cpa.organization_id=? LIMIT 1`,
    ).bind(accountId, customerId, current.organizationId).first<{ user_id: string; email: string }>();
    if (!account) return { formError: "客户门户账号不存在" };
    const passwordError = validatePassword(password);
    if (passwordError) return { formError: passwordError };
    if (password !== confirmPassword) return { formError: "两次输入的新密码不一致" };
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,failed_login_count=0,locked_until=NULL,updated_at=? WHERE id=?")
        .bind(await hashPassword(password), now, account.user_id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(account.user_id),
    ]);
    await writeAudit({ request, action: "portal.password.reset", resourceType: "customer_portal_account", resourceId: accountId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId, email: account.email } });
    return { success: `门户账号 ${account.email} 的密码已重置，原登录会话已退出` };
  }

  if (intent === "contract_upload") {
    const customerId = valueOf(form, "customerId"), title = valueOf(form, "title");
    const file = form.get("attachment");
    if (!(await ownedCustomer(customerId, current.organizationId))) return { formError: "客户不存在" };
    if (title.length < 2) return { formError: "合同名称至少 2 个字符" };
    if (!(file instanceof File) || file.size <= 0) return { formError: "请选择要上传的合同文件" };
    const fileError = validateContractFile(file);
    if (fileError) return { formError: fileError };
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO customer_contracts (id, organization_id, customer_id, title, file_name, content_type, size_bytes, data_url, effective_at, expires_at, status, notes, uploaded_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .bind(id, current.organizationId, customerId, title, file.name, file.type, file.size, await toDataUrl(file), valueOf(form, "effectiveAt") || null, valueOf(form, "expiresAt") || null, valueOf(form, "notes") || null, current.userId, now, now).run();
    await writeAudit({ request, action: "customer.contract.upload", resourceType: "customer_contract", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId, title } });
    return { success: `合同“${title}”已归档到客户资料` };
  }

  if (intent === "contract_archive") {
    const contractId = valueOf(form, "contractId");
    const result = await env.DB.prepare("UPDATE customer_contracts SET status='archived', updated_at=? WHERE id=? AND organization_id=?").bind(now, contractId, current.organizationId).run();
    if (!result.meta.changes) return { formError: "合同不存在或已归档" };
    await writeAudit({ request, action: "customer.contract.archive", resourceType: "customer_contract", resourceId: contractId, organizationId: current.organizationId, actorUserId: current.userId, metadata: {} });
    return { success: "合同已归档" };
  }

  if (intent === "customer_update") {
    const customerId = valueOf(form, "customerId");
    const code = valueOf(form, "code").toLowerCase();
    const name = valueOf(form, "name");
    const shortName = valueOf(form, "shortName");
    const partyCategory = valueOf(form, "partyCategory");
    const ownerId = valueOf(form, "ownerId");
    const status = valueOf(form, "status");
    const notes = valueOf(form, "notes");
    const effectiveOwnerId = canViewAllCustomers(current) ? ownerId : current.userId;
    const profile = customerDefaultProfile(form);
    const submittedRoles = [...new Set(form.getAll("businessRoles").map(String))];
    const businessRoles = submittedRoles.filter(isCustomerBusinessRoleCode);
    const errors: Record<string, string> = {};
    const codeError = code ? validateCode(code) : null;
    const owned = await env.DB.prepare("SELECT id,identity_code FROM customers WHERE id=? AND organization_id=?")
      .bind(customerId, current.organizationId).first<{ id: string; identity_code: string }>();
    if (!owned) errors.customerId = "客户不存在";
    if (codeError) errors.code = codeError;
    if (name.length < 2 || name.length > 120) errors.name = "客户名称需要 2-120 个字符";
    if (!isCustomerPartyCategory(partyCategory)) errors.partyCategory = "请选择有效的客商分类";
    if (!businessRoles.length || businessRoles.length !== submittedRoles.length) errors.businessRoles = "请至少选择一个有效的业务身份";
    if (!['active', 'suspended', 'archived'].includes(status)) errors.status = "客户状态无效";
    if (ownerId && !(await env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'").bind(ownerId, current.organizationId).first())) errors.ownerId = "销售负责人无效";
    const profileError = await validateCustomerDefaultProfile(profile, current.organizationId);
    if (profileError) errors.profile = profileError;
    const values = { customerId, code, name, shortName, partyCategory, businessRoles, ownerId, status, notes, ...profile };
    if (Object.keys(errors).length) return { errors, values };
    const effectiveCode = resolveCustomerCode(code, owned!.identity_code);
    const [existingContact, existingAddress] = await Promise.all([
      env.DB.prepare("SELECT id FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC,updated_at DESC LIMIT 1").bind(customerId).first<{ id: string }>(),
      env.DB.prepare("SELECT id FROM customer_addresses WHERE customer_id=? AND type='shipping' ORDER BY is_default DESC,updated_at DESC LIMIT 1").bind(customerId).first<{ id: string }>(),
    ]);
    const contactId = existingContact?.id || crypto.randomUUID();
    const addressId = existingAddress?.id || crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE customers SET code=?,name=?,short_name=?,party_category=?,type=?,sales_owner_user_id=?,status=?,notes=?,updated_at=? WHERE id=? AND organization_id=?")
          .bind(effectiveCode, name, shortName || null, partyCategory, legacyCustomerTypeForRoles(businessRoles), effectiveOwnerId, status, notes || null, now, customerId, current.organizationId),
        env.DB.prepare("DELETE FROM customer_business_role_assignments WHERE organization_id=? AND customer_id=?").bind(current.organizationId, customerId),
        ...businessRoles.map((roleCode) => env.DB.prepare("INSERT INTO customer_business_role_assignments(id,organization_id,customer_id,role_code,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), current.organizationId, customerId, roleCode, now)),
        env.DB.prepare("UPDATE customer_contacts SET is_primary=0,updated_at=? WHERE customer_id=?").bind(now, customerId),
        existingContact
          ? env.DB.prepare("UPDATE customer_contacts SET name=?,title=?,email=?,phone=?,is_primary=1,updated_at=? WHERE id=? AND customer_id=?")
              .bind(profile.contactName, profile.contactTitle || null, profile.contactEmail || null, profile.contactPhone, now, contactId, customerId)
          : env.DB.prepare("INSERT INTO customer_contacts(id,customer_id,name,title,email,phone,is_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)")
              .bind(contactId, customerId, profile.contactName, profile.contactTitle || null, profile.contactEmail || null, profile.contactPhone, now, now),
        env.DB.prepare("UPDATE customer_addresses SET is_default=0,updated_at=? WHERE customer_id=? AND type='shipping'").bind(now, customerId),
        existingAddress
          ? env.DB.prepare("UPDATE customer_addresses SET label='默认提货地',country_code=?,state=?,city=?,address_line1=?,contact_name=?,contact_phone=?,is_default=1,updated_at=? WHERE id=? AND customer_id=?")
              .bind(profile.addressCountryCode, profile.addressState, profile.addressCity, profile.addressLine1, profile.contactName, profile.contactPhone, now, addressId, customerId)
          : env.DB.prepare("INSERT INTO customer_addresses(id,customer_id,type,label,country_code,state,city,address_line1,contact_name,contact_phone,is_default,created_at,updated_at) VALUES(?,?,'shipping','默认提货地',?,?,?,?,?,?,1,?,?)")
              .bind(addressId, customerId, profile.addressCountryCode, profile.addressState, profile.addressCity, profile.addressLine1, profile.contactName, profile.contactPhone, now, now),
      ]);
    } catch {
      return { formError: "客户代码不能重复", values };
    }
    await writeAudit({ request, action: "customer.update", resourceType: "customer", resourceId: customerId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { code: effectiveCode, partyCategory, businessRoles, status } });
    return { success: `客户“${name}”已更新` };
  }

  const code = valueOf(form, "code").toLowerCase(), name = valueOf(form, "name"), shortName = valueOf(form, "shortName"), partyCategory = valueOf(form, "partyCategory"), ownerId = valueOf(form, "ownerId"), notes = valueOf(form, "notes"), profile = customerDefaultProfile(form);
  const portalDisplayName = valueOf(form, "portalDisplayName");
  const portalEmail = valueOf(form, "portalEmail").toLowerCase();
  const portalPassword = valueOf(form, "portalPassword");
  const portalConfirmPassword = valueOf(form, "portalConfirmPassword");
  const archiveContract = form.has("archiveContract");
  const contractTitle = valueOf(form, "contractTitle");
  const contractEffectiveAt = valueOf(form, "contractEffectiveAt");
  const contractExpiresAt = valueOf(form, "contractExpiresAt");
  const contractNotes = valueOf(form, "contractNotes");
  const contractAttachment = form.get("contractAttachment");
  const effectiveOwnerId = canViewAllCustomers(current) ? (ownerId || null) : current.userId;
  const submittedRoles = [...new Set(form.getAll("businessRoles").map(String))];
  const businessRoles = submittedRoles.filter(isCustomerBusinessRoleCode);
  const errors: Record<string, string> = {};
  const codeError = code ? validateCode(code) : null; if (codeError) errors.code = codeError;
  if (name.length < 2 || name.length > 120) errors.name = "客户名称需要 2-120 个字符";
  if (!isCustomerPartyCategory(partyCategory)) errors.partyCategory = "请选择客商分类";
  if (!businessRoles.length || businessRoles.length !== submittedRoles.length) errors.businessRoles = "请至少选择一个有效的业务身份";
  if (ownerId && !(await env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'").bind(ownerId, current.organizationId).first())) errors.ownerId = "销售负责人无效";
  const profileError = await validateCustomerDefaultProfile(profile, current.organizationId);
  if (profileError) errors.profile = profileError;
  if (portalDisplayName.length < 2) errors.portalDisplayName = "门户用户姓名至少 2 个字符";
  const emailError = validateEmail(portalEmail);
  if (emailError) errors.portalEmail = emailError;
  const passwordError = validatePassword(portalPassword);
  if (passwordError) errors.portalPassword = passwordError;
  if (portalPassword !== portalConfirmPassword) errors.portalConfirmPassword = "两次输入的密码不一致";
  if (!errors.portalEmail && await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(portalEmail).first()) errors.portalEmail = "该邮箱已被使用";
  if (archiveContract) {
    if (contractTitle.length < 2) errors.contractTitle = "合同名称至少 2 个字符";
    if (!(contractAttachment instanceof File) || contractAttachment.size <= 0) errors.contractAttachment = "请选择要上传的合同文件";
    else {
      const fileError = validateContractFile(contractAttachment);
      if (fileError) errors.contractAttachment = fileError;
    }
    if (contractEffectiveAt && contractExpiresAt && contractExpiresAt < contractEffectiveAt) errors.contractDates = "到期日期不能早于生效日期";
  }
  const values = {
    code, name, shortName, partyCategory, businessRoles, ownerId, notes, ...profile,
    portalDisplayName, portalEmail,
    archiveContract, contractTitle, contractEffectiveAt, contractExpiresAt, contractNotes,
  };
  if (Object.keys(errors).length) return { errors, values };
  const id = crypto.randomUUID(), identityCode = await nextCustomerIdentityCode(current.organizationId);
  if (!identityCode) return { formError: "暂时无法生成客户识别码，请重试", values };
  const effectiveCode = resolveCustomerCode(code, identityCode);
  const contactId = crypto.randomUUID(), addressId = crypto.randomUUID();
  const portalUserId = crypto.randomUUID();
  const portalAccountId = crypto.randomUUID();
  const contractId = archiveContract ? crypto.randomUUID() : null;
  const portalPasswordHash = await hashPassword(portalPassword);
  const contractDataUrl = archiveContract && contractAttachment instanceof File ? await toDataUrl(contractAttachment) : null;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO customers (id, organization_id, code, identity_code, name, short_name, party_category, type, sales_owner_user_id, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(id, current.organizationId, effectiveCode, identityCode, name, shortName || null, partyCategory, legacyCustomerTypeForRoles(businessRoles), effectiveOwnerId, notes || null, now, now),
      ...businessRoles.map((roleCode) => env.DB.prepare("INSERT INTO customer_business_role_assignments(id,organization_id,customer_id,role_code,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), current.organizationId, id, roleCode, now)),
      env.DB.prepare("INSERT INTO customer_contacts(id,customer_id,name,title,email,phone,is_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)")
        .bind(contactId, id, profile.contactName, profile.contactTitle || null, profile.contactEmail || null, profile.contactPhone, now, now),
      env.DB.prepare("INSERT INTO customer_addresses(id,customer_id,type,label,country_code,state,city,address_line1,contact_name,contact_phone,is_default,created_at,updated_at) VALUES(?,?,'shipping','默认提货地',?,?,?,?,?,?,1,?,?)")
        .bind(addressId, id, profile.addressCountryCode, profile.addressState, profile.addressCity, profile.addressLine1, profile.contactName, profile.contactPhone, now, now),
      env.DB.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(portalUserId, portalEmail, portalPasswordHash, portalDisplayName, now, now),
      env.DB.prepare("INSERT INTO customer_portal_accounts (id,organization_id,customer_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(portalAccountId, current.organizationId, id, portalUserId, now, now),
      ...(archiveContract && contractId && contractAttachment instanceof File ? [
        env.DB.prepare("INSERT INTO customer_contracts (id,organization_id,customer_id,title,file_name,content_type,size_bytes,data_url,effective_at,expires_at,status,notes,uploaded_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)")
          .bind(contractId, current.organizationId, id, contractTitle, contractAttachment.name, contractAttachment.type, contractAttachment.size, contractDataUrl, contractEffectiveAt || null, contractExpiresAt || null, contractNotes || null, current.userId, now, now),
      ] : []),
    ]);
  } catch { return { formError: "客户代码、识别码或门户邮箱不能重复", values }; }
  await writeAudit({ request, action: "customer.create", resourceType: "customer", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { code: effectiveCode, identityCode, partyCategory, businessRoles } });
  await writeAudit({ request, action: "portal.account.create", resourceType: "customer_portal_account", resourceId: portalAccountId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId: id, email: portalEmail, source: "customer.create" } });
  if (contractId) await writeAudit({ request, action: "customer.contract.upload", resourceType: "customer_contract", resourceId: contractId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { customerId: id, title: contractTitle, source: "customer.create" } });
  return { success: "客户已创建", customerId: id };
}

async function ownedCustomer(id: string, organizationId: string) {
  return env.DB.prepare("SELECT id FROM customers WHERE id = ? AND organization_id = ?").bind(id, organizationId).first();
}

const maxInlineContractBytes = 1_200_000;

function validateContractFile(file: File) {
  if (file.size > maxInlineContractBytes) return "合同文件不能超过 1.2MB；更大的文件请先压缩或拆分";
  if (!file.type) return "无法识别文件类型";
  return null;
}

async function toDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function nextCustomerIdentityCode(organizationId:string):Promise<string|null>{
  for(let attempt=0;attempt<12;attempt+=1){
    const code=generateCustomerIdentityCode();
    const exists=await env.DB.prepare("SELECT 1 FROM customers WHERE organization_id=? AND identity_code=?").bind(organizationId,code).first();
    if(!exists)return code;
  }
  return null;
}

export function meta() { return [{ title: "客户管理 | International TMS" }]; }

function customerActionError(
  actionData: unknown,
  expectedIntent: string | readonly string[],
  customerId?: string,
  accountId?: string,
) {
  if (!actionData || typeof actionData !== "object") return undefined;
  const data = actionData as Record<string, unknown>;
  const intents = Array.isArray(expectedIntent) ? expectedIntent : [expectedIntent];
  if (!intents.includes(String(data.intent ?? ""))) return undefined;
  if (customerId && data.customerId !== customerId) return undefined;
  if (accountId && data.accountId !== accountId) return undefined;
  return typeof data.formError === "string" ? data.formError : undefined;
}

function CustomerModalActionError({ actionData, intent, customerId, accountId }: {
  actionData: unknown;
  intent: string | readonly string[];
  customerId?: string;
  accountId?: string;
}) {
  const message = customerActionError(actionData, intent, customerId, accountId);
  return message
    ? <div className="alert error" role="alert"><strong>操作尚未完成</strong><span>{message}</span><small>已填写内容仍保留，请按提示修改后重试。</small></div>
    : null;
}

export default function Customers({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle", canManage = loaderData.customerAccess.canManage;
  const canReviewRegistrations = loaderData.customerAccess.canReviewRegistrations;
  const bindableCustomers = loaderData.customers.filter((customer) => customer.status !== "archived");
  const modalCloseSignal = actionData?.success ? actionData : undefined;
  const submittedValues = actionData && "values" in actionData ? actionData.values : undefined;
  const submittedErrors = actionData && "errors" in actionData ? actionData.errors : undefined;
  const submittedCustomerId = submittedValues && "customerId" in submittedValues ? submittedValues.customerId : undefined;
  return <>
    <header className="page-header customer-page-header">
      <div><p className="eyebrow">CUSTOMER 360</p><h1>客户管理</h1><p>{loaderData.customerAccess.description}</p></div>
      <div className="page-actions">
        <span className="status-pill">{loaderData.customerAccess.scopeLabel} · {loaderData.customers.length} 家</span>
        <span className={`status-pill ${canManage ? "success" : "off"}`}>{loaderData.customerAccess.operationLabel}</span>
      </div>
    </header>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    <section className="panel portal-registration-review" id="portal-registration-requests">
      <div className="panel-header"><div><h2>客户门户注册申请</h2><p>申请人只能提交资料；必须在这里确认最终客户，批准后才会开放该客户的订单、报价和账单。</p></div><span className={`status-pill ${loaderData.registrations.length ? "warning" : "success"}`}>{loaderData.registrations.length} 条待审核</span></div>
      <div className="table-wrap"><table><thead><tr><th>申请时间</th><th>企业资料</th><th>联系人 / 登录邮箱</th><th>系统预匹配</th><th>绑定客户并处理</th></tr></thead><tbody>{loaderData.registrations.map((registration) => <tr key={registration.id}>
        <td>{new Date(registration.created_at).toLocaleString("zh-CN", { hour12: false })}</td>
        <td><strong>{registration.company_name}</strong><small>{registration.customer_identity_code ? `客户识别码 ${registration.customer_identity_code}` : "未填写客户识别码"}</small></td>
        <td><strong>{registration.contact_name}</strong><small>{registration.email}{registration.contact_phone ? ` · ${registration.contact_phone}` : ""}</small></td>
        <td>{registration.candidate_customer_id ? <><span className="status-pill">已预匹配</span><small>{registration.candidate_customer_name}</small></> : <><span className="status-pill off">未匹配</span><small>请人工选择客户</small></>}</td>
        <td>{canReviewRegistrations ? <div className="portal-registration-actions">
          <Form method="post" className="portal-registration-approve-form"><input type="hidden" name="intent" value="portal_registration_approve"/><input type="hidden" name="requestId" value={registration.id}/><label><span>最终绑定客户</span><select name="customerId" defaultValue={registration.candidate_customer_id ?? ""} required><option value="">请选择客户档案</option>{bindableCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.identity_code} · {customer.name}</option>)}</select></label><button className="primary" disabled={busy}>批准并绑定</button></Form>
          <Form method="post" className="portal-registration-reject-form"><input type="hidden" name="intent" value="portal_registration_reject"/><input type="hidden" name="requestId" value={registration.id}/><label><span>拒绝原因</span><input name="reviewNotes" required minLength={2} maxLength={240} placeholder="例如：企业资料与客户档案不一致"/></label><button className="secondary danger" disabled={busy}>拒绝</button></Form>
        </div> : <span className="muted">仅可查看</span>}</td>
      </tr>)}{!loaderData.registrations.length&&<tr><td colSpan={5} className="empty-state">暂无待审核的客户门户注册申请。</td></tr>}</tbody></table></div>
    </section>
    <section className="panel customer-ledger">
      <div className="panel-header">
        <div><h2>客户资料台账</h2><p>一行一位客商；点击“客户档案”集中维护联系人、地址、合同和门户账号。</p></div>
        {canManage && <Modal title="新增客户" triggerLabel="新增客户" size="xwide" dialogClassName="customer-editor-modal" closeSignal={modalCloseSignal} guardFormChanges>
          <CustomerEditorForm
            intent="customer"
            owners={loaderData.owners}
            countries={loaderData.countries}
            provinces={loaderData.provinces}
            cities={loaderData.cities}
            busy={busy}
            values={submittedCustomerId ? undefined : submittedValues}
            errors={submittedCustomerId ? undefined : submittedErrors}
            formError={customerActionError(actionData,"customer")}
          />
        </Modal>}
      </div>
      <div className="table-wrap customer-ledger-table">
        <table>
          <thead><tr><th>识别码</th><th>客户名称 / 代码</th><th>分类 / 业务身份</th><th>默认联系人</th><th>默认提货地址</th><th>负责人 / 状态</th><th className="sticky-action">操作</th></tr></thead>
          <tbody>{loaderData.customers.map((customer) => {
            const roles = customer.business_role_codes.split(",").filter(Boolean) as CustomerBusinessRoleCode[];
            const editValues = submittedCustomerId === customer.id ? submittedValues : undefined;
            return <tr key={customer.id}>
              <td><code className="identity-code">{customer.identity_code}</code></td>
              <td><strong>{customer.name}</strong><small>{customer.code}{customer.short_name ? ` · ${customer.short_name}` : ""}</small></td>
              <td><strong>{customerPartyCategoryLabel(customer.party_category)}</strong><small>{roles.map(customerBusinessRoleLabel).join("、") || "未设置业务身份"}</small></td>
              <td><strong>{customer.primary_contact_name || "未填写"}</strong><small>{customer.primary_contact_title ? `${customer.primary_contact_title} · ` : ""}{customer.primary_contact_phone || customer.primary_contact_email || `${customer.contact_count} 位联系人`}</small></td>
              <td><strong>{customer.default_address_city || "未填写"}</strong><small>{customer.default_address_line1 || `${customer.address_count} 个地址`}</small></td>
              <td><strong>{customer.sales_owner_name || "未指定"}</strong><small>{customer.status === "active" ? "正常" : customer.status === "suspended" ? "暂停" : "归档"}</small></td>
              <td className="sticky-action"><div className="row-actions">
                <Modal title={`客户档案 · ${customer.name}`} triggerLabel="客户档案" triggerClassName="text-button" size="xwide" dialogClassName="customer-dossier-modal">
                  <CustomerDossier
                    customer={customer}
                    roles={roles}
                    contacts={loaderData.contacts.filter((item) => item.customer_id === customer.id)}
                    addresses={loaderData.addresses.filter((item) => item.customer_id === customer.id)}
                    portals={loaderData.portals.filter((item) => item.customer_id === customer.id)}
                    contracts={loaderData.contracts.filter((item) => item.customer_id === customer.id)}
                    countries={loaderData.countries}
                    provinces={loaderData.provinces}
                    cities={loaderData.cities}
                    canManage={canManage}
                    busy={busy}
                    closeSignal={modalCloseSignal}
                    actionData={actionData}
                  />
                </Modal>
                {canManage && <Modal title={`编辑客户 · ${customer.name}`} triggerLabel="编辑" triggerClassName="text-button" size="xwide" dialogClassName="customer-editor-modal" closeSignal={modalCloseSignal} guardFormChanges>
                  <CustomerEditorForm intent="customer_update" customer={customer} owners={loaderData.owners} countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities} busy={busy} values={editValues} errors={editValues ? submittedErrors : undefined} formError={customerActionError(actionData,"customer_update",customer.id)} selectedRoles={roles}/>
                </Modal>}
              </div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!loaderData.customers.length && <p className="empty-state">暂无客户，请点击右上角“新增客户”。</p>}
    </section>
  </>;
}

function CustomerDossier({ customer, roles, contacts, addresses, portals, contracts, countries, provinces, cities, canManage, busy, closeSignal, actionData }: {
  customer: CustomerRow;
  roles: CustomerBusinessRoleCode[];
  contacts: ContactRow[];
  addresses: AddressRow[];
  portals: PortalRow[];
  contracts: ContractRow[];
  countries: { code: string; name: string }[];
  provinces: GeoReference[];
  cities: GeoReference[];
  canManage: boolean;
  busy: boolean;
  closeSignal?: unknown;
  actionData?: unknown;
}) {
  const archivedContractId = actionData && typeof actionData === "object"
    ? String((actionData as Record<string, unknown>).contractId ?? "")
    : "";
  const contractArchiveError = contracts.some((item) => item.id === archivedContractId)
    ? customerActionError(actionData, "contract_archive")
    : undefined;
  return <div className="customer-dossier">
    <div className="customer-dossier-summary table-wrap"><table><tbody><tr>
      <th>客户代码</th><td>{customer.code}</td><th>系统识别码</th><td><code>{customer.identity_code}</code></td><th>客商分类</th><td>{customerPartyCategoryLabel(customer.party_category)}</td><th>状态</th><td>{customer.status === "active" ? "正常" : customer.status === "suspended" ? "暂停" : "归档"}</td>
    </tr><tr><th>业务身份</th><td colSpan={3}>{roles.map(customerBusinessRoleLabel).join("、") || "未设置"}</td><th>销售负责人</th><td>{customer.sales_owner_name || "未指定"}</td><th>备注</th><td>{customer.notes || "—"}</td></tr></tbody></table></div>
    {canManage && <div className="customer-dossier-actions" aria-label="客户档案操作">
      <Modal title={`归档客户合同 · ${customer.name}`} triggerLabel="归档合同" triggerClassName="secondary" size="wide" dialogClassName="customer-submodal" closeSignal={closeSignal} guardFormChanges><CustomerModalActionError actionData={actionData} intent="contract_upload" customerId={customer.id}/><CustomerContractForm customer={customer} busy={busy}/></Modal>
      <Modal title={`添加联系人 · ${customer.name}`} triggerLabel="添加联系人" triggerClassName="secondary" size="wide" dialogClassName="customer-submodal" closeSignal={closeSignal} guardFormChanges><CustomerModalActionError actionData={actionData} intent="contact" customerId={customer.id}/><CustomerContactForm customer={customer} busy={busy}/></Modal>
      <Modal title={`添加常用地址 · ${customer.name}`} triggerLabel="添加常用地址" triggerClassName="secondary" size="wide" dialogClassName="customer-submodal" closeSignal={closeSignal} guardFormChanges><CustomerModalActionError actionData={actionData} intent="address" customerId={customer.id}/><CustomerAddressForm customer={customer} countries={countries} busy={busy}/></Modal>
      <Modal title={`添加常用提货地 · ${customer.name}`} triggerLabel="添加提货地" triggerClassName="secondary" size="wide" dialogClassName="customer-submodal" closeSignal={closeSignal} guardFormChanges><CustomerModalActionError actionData={actionData} intent="pickup_address" customerId={customer.id}/><CustomerPickupAddressForm customer={customer} countries={countries} provinces={provinces} cities={cities} busy={busy}/></Modal>
      <Modal title={`开通客户门户 · ${customer.name}`} triggerLabel="开通门户" triggerClassName="secondary" size="wide" dialogClassName="customer-submodal" closeSignal={closeSignal} guardFormChanges><CustomerModalActionError actionData={actionData} intent="portal" customerId={customer.id}/><CustomerPortalForm customer={customer} busy={busy}/></Modal>
    </div>}
    <DossierSection title="联系人" count={contacts.length} columns={["姓名 / 职务", "电话", "邮箱", "标记"]} rows={contacts.map((item) => [item.name + (item.title ? ` · ${item.title}` : ""), item.phone || "—", item.email || "—", item.is_primary ? "主要联系人" : "普通联系人"])} />
    <DossierSection title="常用地址与提货地" count={addresses.length} columns={["地址名称", "类型", "城市", "详细地址", "标记"]} rows={addresses.map((item) => [item.label, addressTypeLabel(item.type), `${item.country_code} · ${item.state || "—"} · ${item.city}`, item.address_line1, item.is_default ? "默认" : "—"])} />
    <CustomerPortalAccountsSection customer={customer} portals={portals} canManage={canManage} busy={busy} closeSignal={closeSignal} actionData={actionData} />
    <section className="customer-dossier-section"><div className="customer-dossier-section-head"><strong>合同归档</strong><span>{contracts.length} 份</span></div>{contractArchiveError && <div className="alert error" role="alert"><strong>合同尚未归档</strong><span>{contractArchiveError}</span><small>当前客户档案仍保持打开，请刷新状态后重试。</small></div>}<div className="table-wrap"><table><thead><tr><th>合同名称</th><th>文件</th><th>有效期</th><th>状态 / 备注</th><th>操作</th></tr></thead><tbody>{contracts.length ? contracts.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.file_name}<small>{Math.ceil(item.size_bytes / 1024)} KB</small></td><td>{item.effective_at || "未填"} — {item.expires_at || "未填"}</td><td>{item.status === "active" ? "有效" : "已归档"}<small>{item.notes || "—"}</small></td><td><div className="row-actions"><a className="text-button" href={`/admin/customer-contracts/${item.id}/download`}>下载</a>{canManage && item.status === "active" && <Form method="post" className="inline-form"><input type="hidden" name="intent" value="contract_archive"/><input type="hidden" name="contractId" value={item.id}/><button className="text-button" disabled={busy}>归档</button></Form>}</div></td></tr>) : <tr><td colSpan={5} className="empty-state">暂无合同</td></tr>}</tbody></table></div></section>
  </div>;
}

function DossierSection({ title, count, columns, rows }: { title: string; count: number; columns: string[]; rows: string[][] }) {
  return <section className="customer-dossier-section"><div className="customer-dossier-section-head"><strong>{title}</strong><span>{count} 条</span></div><div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, rowIndex) => <tr key={`${title}-${rowIndex}`}>{row.map((value, columnIndex) => <td key={`${title}-${rowIndex}-${columnIndex}`}>{value}</td>)}</tr>) : <tr><td colSpan={columns.length} className="empty-state">暂无数据</td></tr>}</tbody></table></div></section>;
}

function CustomerPortalAccountsSection({ customer, portals, canManage, busy, closeSignal, actionData }: { customer: CustomerRow; portals: PortalRow[]; canManage: boolean; busy: boolean; closeSignal?: unknown; actionData?: unknown }) {
  return <section className="customer-dossier-section customer-portal-accounts"><div className="customer-dossier-section-head"><strong>门户账号</strong><span>{portals.length} 个</span></div><div className="table-wrap"><table><thead><tr><th>登录用户</th><th>登录账号</th><th>密码</th><th>状态 / 最近登录</th><th>操作</th></tr></thead><tbody>{portals.length ? portals.map((item) => <tr key={item.id}>
    <td><strong>{item.display_name}</strong></td>
    <td><code>{item.email}</code><small>客户门户登录邮箱</small></td>
    <td><span className="status-pill">已加密保存</span><small>安全原因不可回显明文</small></td>
    <td><span className={`status-pill${item.status === "active" ? "" : " off"}`}>{item.status === "active" ? "正常" : item.status}</span><small>{item.last_login_at ? `最近登录 ${item.last_login_at}` : "尚未登录"}</small></td>
    <td>{canManage ? <Modal title={`重置门户密码 · ${item.email}`} triggerLabel="重置密码" triggerClassName="text-button" size="wide" dialogClassName="customer-submodal" closeSignal={closeSignal} guardFormChanges><CustomerModalActionError actionData={actionData} intent="portal_password_reset" customerId={customer.id} accountId={item.id}/><CustomerPortalPasswordResetForm customer={customer} account={item} busy={busy}/></Modal> : "—"}</td>
  </tr>) : <tr><td colSpan={5} className="empty-state">尚未开通门户账号；该客户的报价暂时无法在客户门户查看。</td></tr>}</tbody></table></div></section>;
}

function CustomerPortalPasswordResetForm({ customer, account, busy }: { customer: CustomerRow; account: PortalRow; busy: boolean }) {
  return <Form method="post" className="customer-subform"><input type="hidden" name="intent" value="portal_password_reset"/><input type="hidden" name="customerId" value={customer.id}/><input type="hidden" name="accountId" value={account.id}/><div className="customer-form-section"><div className="customer-form-section-title"><strong>设置新的初始密码</strong><span>保存后原有门户登录会话将全部退出</span></div><div className="customer-form-grid"><label className="field field-wide"><span>登录账号</span><input value={account.email} autoComplete="username" disabled/></label><label className="field field-wide"><span>新密码</span><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/><small>至少 12 位，包含大小写字母和数字</small></label><label className="field field-wide"><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/></label></div></div><div className="customer-form-actions"><span>系统不会保存或展示明文密码，请将新密码通过安全渠道交给客户。</span><button className="primary" disabled={busy}>确认重置密码</button></div></Form>;
}

function CustomerContractForm({ customer, busy }: { customer: CustomerRow; busy: boolean }) {
  return <Form method="post" className="customer-subform" encType="multipart/form-data"><input type="hidden" name="intent" value="contract_upload"/><input type="hidden" name="customerId" value={customer.id}/><div className="customer-form-section"><div className="customer-form-section-title"><strong>合同资料</strong><span>文件不超过 1.2MB</span></div><div className="customer-form-grid"><label className="field field-wide"><span>合同名称</span><input name="title" required maxLength={120} placeholder="2026 年度运输框架合同"/></label><label className="field field-wide"><span>合同文件</span><input name="attachment" type="file" required accept="image/*,application/pdf"/></label><label className="field field-short"><span>生效日期</span><input name="effectiveAt" type="date"/></label><label className="field field-short"><span>到期日期</span><input name="expiresAt" type="date"/></label><label className="field span-all"><span>备注</span><textarea name="notes" rows={3} maxLength={1000} placeholder="填写合同编号、签署方和补充说明"/></label></div></div><div className="customer-form-actions"><span>合同归档在客户资料中，不作为逐单重复上传项。</span><button className="primary" disabled={busy}>确认上传并归档</button></div></Form>;
}

function CustomerContactForm({ customer, busy }: { customer: CustomerRow; busy: boolean }) {
  return <Form method="post" className="customer-subform"><input type="hidden" name="intent" value="contact"/><input type="hidden" name="customerId" value={customer.id}/><div className="customer-form-section"><div className="customer-form-section-title"><strong>联系人信息</strong><span>短字段使用紧凑输入框</span></div><div className="customer-form-grid"><label className="field field-medium"><span>姓名</span><input name="name" required maxLength={80}/></label><label className="field field-medium"><span>职务</span><input name="title" maxLength={80}/></label><label className="field field-medium"><span>电话</span><input name="phone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" maxLength={30}/></label><label className="field field-wide"><span>邮箱</span><input name="email" type="email" maxLength={254}/></label><label className="check-field span-all"><input name="isPrimary" type="checkbox"/>设为主要联系人</label></div></div><div className="customer-form-actions"><span>设为主要联系人时，系统会自动取消原主要联系人。</span><button className="primary" disabled={busy}>确认添加联系人</button></div></Form>;
}

function CustomerAddressForm({ customer, countries, busy }: { customer: CustomerRow; countries: { code: string; name: string }[]; busy: boolean }) {
  return <Form method="post" className="customer-subform"><input type="hidden" name="intent" value="address"/><input type="hidden" name="customerId" value={customer.id}/><div className="customer-form-section"><div className="customer-form-section-title"><strong>常用地址</strong><span>用于收发货、仓库、账单或注册地址</span></div><div className="customer-form-grid"><label className="field field-medium"><span>地址名称</span><input name="label" required maxLength={80} placeholder="上海仓库"/></label><label className="field field-short"><span>类型</span><select name="type"><option value="shipping">收发货</option><option value="warehouse">仓库</option><option value="billing">账单</option><option value="registered">注册地址</option></select></label><label className="field field-short"><span>国家/地区</span><select name="countryCode">{countries.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label><label className="field field-medium"><span>城市</span><input name="city" required maxLength={80}/></label><label className="field span-all"><span>详细地址</span><input name="addressLine1" required maxLength={240}/></label><label className="check-field span-all"><input name="isDefault" type="checkbox"/>设为默认地址</label></div></div><div className="customer-form-actions"><span>保存后可在报价和订单中直接选择。</span><button className="primary" disabled={busy}>确认添加地址</button></div></Form>;
}

function CustomerPickupAddressForm({ customer, countries, provinces, cities, busy }: { customer: CustomerRow; countries: { code: string; name: string }[]; provinces: GeoReference[]; cities: GeoReference[]; busy: boolean }) {
  return <Form method="post" className="customer-subform"><input type="hidden" name="intent" value="pickup_address"/><input type="hidden" name="customerId" value={customer.id}/><div className="customer-form-section"><div className="customer-form-section-title"><strong>常用提货地</strong><span>国家、省州和城市必须保持层级一致</span></div><div className="customer-form-grid"><label className="field field-medium"><span>提货地名称</span><input name="label" required maxLength={80} placeholder="深圳工厂"/></label><PickupAddressFields countries={countries} provinces={provinces} cities={cities}/><label className="field span-all"><span>详细地址</span><input name="addressLine1" required maxLength={240} placeholder="街道、门牌号、园区和楼栋"/></label><label className="field field-medium"><span>提货联系人</span><input name="contactName" maxLength={80}/></label><label className="field field-medium"><span>联系电话</span><input name="contactPhone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" maxLength={30}/></label><label className="check-field span-all"><input name="isDefault" type="checkbox"/>设为默认提货地</label></div></div><div className="customer-form-actions"><span>默认提货地会自动继承到新报价。</span><button className="primary" disabled={busy}>确认保存提货地</button></div></Form>;
}

function CustomerPortalForm({ customer, busy }: { customer: CustomerRow; busy: boolean }) {
  return <Form method="post" className="customer-subform"><input type="hidden" name="intent" value="portal"/><input type="hidden" name="customerId" value={customer.id}/><div className="customer-form-section"><div className="customer-form-section-title"><strong>门户登录资料</strong><span>开通后客户可确认报价、下载唛头并接收自提提醒</span></div><div className="customer-form-grid"><label className="field field-medium"><span>用户姓名</span><input name="displayName" autoComplete="name" required maxLength={80}/></label><label className="field field-wide"><span>登录邮箱</span><input name="email" type="email" autoComplete="email" required maxLength={254}/></label><label className="field field-wide"><span>初始密码</span><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/><small>至少 12 位，包含大小写字母和数字</small></label></div></div><div className="customer-form-actions"><span>账号创建成功后可立即登录客户门户。</span><button className="primary" disabled={busy}>确认开通门户</button></div></Form>;
}

function addressTypeLabel(type: string) {
  return type === "shipping" ? "收发货" : type === "warehouse" ? "仓库" : type === "billing" ? "账单" : type === "registered" ? "注册地址" : type;
}

type CustomerFormValues = {
  customerId?: string;
  code?: string;
  name?: string;
  shortName?: string;
  partyCategory?: string;
  businessRoles?: CustomerBusinessRoleCode[];
  ownerId?: string;
  status?: string;
  notes?: string;
  contactName?: string;
  contactTitle?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressCountryCode?: string;
  addressState?: string;
  addressCity?: string;
  addressLine1?: string;
};

function CustomerForm({
  intent,
  customer,
  owners,
  countries,
  provinces,
  cities,
  busy,
  values,
  errors,
  formError,
  selectedRoles = [],
}: {
  intent: "customer" | "customer_update";
  customer?: CustomerRow;
  owners: { id: string; display_name: string }[];
  countries: { code: string; name: string }[];
  provinces: GeoReference[];
  cities: GeoReference[];
  busy: boolean;
  values?: CustomerFormValues;
  errors?: Record<string, string>;
  formError?: string;
  selectedRoles?: CustomerBusinessRoleCode[];
}) {
  const editing = intent === "customer_update";
  const roles = values?.businessRoles ?? selectedRoles;
  const errorFields = Object.keys(errors ?? {});
  const errorSummary = formError || (errorFields.length
    ? `请检查 ${errorFields.length} 处标记的必填或格式问题`
    : undefined);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!errorSummary) return;
    const frame = window.requestAnimationFrame(() => {
      errorSummaryRef.current?.focus();
      errorSummaryRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errorSummary]);
  return <Form method="post" className="customer-editor-form" data-enter-flow>
    <input type="hidden" name="intent" value={intent} />
    {customer && <input type="hidden" name="customerId" value={customer.id} />}
    {errorSummary && <div ref={errorSummaryRef} className="alert error" role="alert" tabIndex={-1}><strong>客户资料尚未保存</strong><span>{errorSummary}</span><small>已填写内容仍保留，请按提示修改后重试。</small></div>}
    <section className="customer-form-section">
      <div className="customer-form-section-title"><strong>1. 客户基本信息</strong><span>客户代码选填；留空时由系统自动生成</span></div>
      <div className="customer-form-grid customer-basic-grid">
        <label className="field field-wide"><span>客户全称</span><input name="name" required maxLength={120} defaultValue={values?.name ?? customer?.name}/>{errors?.name && <small className="field-error">{errors.name}</small>}</label>
        <label className="field field-short"><span>客商分类</span><select name="partyCategory" required defaultValue={values?.partyCategory ?? customer?.party_category ?? "customer"}><option value="">请选择</option>{customerPartyCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{errors?.partyCategory && <small className="field-error">{errors.partyCategory}</small>}</label>
        <CustomerBusinessRolePicker selected={roles} error={errors?.businessRoles}/>
        <label className="field field-short"><span>客户代码 <em>选填</em></span><input name="code" maxLength={40} placeholder="留空自动生成" defaultValue={values?.code ?? customer?.code}/>{errors?.code && <small className="field-error">{errors.code}</small>}</label>
        <label className="field field-medium"><span>客户简称 <em>选填</em></span><input name="shortName" maxLength={80} defaultValue={values?.shortName ?? customer?.short_name ?? ""}/></label>
        <label className="field field-medium"><span>销售负责人 <em>选填</em></span><select name="ownerId" defaultValue={values?.ownerId ?? customer?.sales_owner_user_id ?? ""}><option value="">未指定</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.display_name}</option>)}</select>{errors?.ownerId && <small className="field-error">{errors.ownerId}</small>}</label>
        <label className="field field-short"><span>客户识别码</span><input value={customer?.identity_code ?? "创建后自动生成"} disabled/><small>{editing ? "不可修改" : "排除 O、0、1、L"}</small></label>
        {editing && <label className="field field-short"><span>状态</span><select name="status" required defaultValue={values?.status ?? customer?.status ?? "active"}><option value="active">正常</option><option value="suspended">暂停</option><option value="archived">归档</option></select>{errors?.status && <small className="field-error">{errors.status}</small>}</label>}
      </div>
    </section>
    <section className="customer-form-section">
      <div className="customer-form-section-title"><strong>2. 默认联系人</strong><span>创建订单时可直接继承</span></div>
      <div className="customer-form-grid customer-contact-grid">
        <label className="field field-medium"><span>联系人姓名</span><input name="contactName" required maxLength={80} defaultValue={values?.contactName ?? customer?.primary_contact_name ?? ""} placeholder="请输入联系人姓名" /></label>
        <label className="field field-medium"><span>联系电话</span><input name="contactPhone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" required maxLength={30} defaultValue={values?.contactPhone ?? customer?.primary_contact_phone ?? ""} placeholder="请输入联系电话" /></label>
        <label className="field field-medium"><span>职务 <em>选填</em></span><input name="contactTitle" maxLength={80} defaultValue={values?.contactTitle ?? customer?.primary_contact_title ?? ""}/></label>
        <label className="field field-wide"><span>邮箱 <em>选填</em></span><input name="contactEmail" type="email" maxLength={254} defaultValue={values?.contactEmail ?? customer?.primary_contact_email ?? ""}/></label>
      </div>
    </section>
    <section className="customer-form-section">
      <div className="customer-form-section-title"><strong>3. 默认提货地址</strong><span>报价和订单将默认带入，也可在业务单据中改选</span></div>
      <div className="customer-form-grid customer-address-grid">
        <PickupAddressFields
          countries={countries}
          provinces={provinces}
          cities={cities}
          countryName="addressCountryCode"
          stateName="addressState"
          cityName="addressCity"
          initialCountry={values?.addressCountryCode ?? customer?.default_address_country_code ?? "CN"}
          initialState={values?.addressState ?? customer?.default_address_state ?? ""}
          initialCity={values?.addressCity ?? customer?.default_address_city ?? ""}
        />
        <label className="field span-all"><span>详细地址</span><input name="addressLine1" required maxLength={240} defaultValue={values?.addressLine1 ?? customer?.default_address_line1 ?? ""} placeholder="街道、门牌号、园区和楼栋" /></label>
      </div>
      {errors?.profile && <small className="field-error">{errors.profile}</small>}
    </section>
    <section className="customer-form-section customer-notes-section"><div className="customer-form-grid"><label className="field span-all"><span>备注 <em>选填</em></span><textarea name="notes" rows={2} maxLength={1000} defaultValue={values?.notes ?? customer?.notes ?? ""} placeholder="填写结算习惯、沟通偏好或其他客户说明"/></label></div></section>
    <div className="customer-form-actions"><span>确认后将同时创建客户、默认联系人和默认提货地址。</span><button className="primary" disabled={busy}>{editing ? "确认保存客户信息" : "确认创建客户"}</button></div>
  </Form>;
}

function CustomerBusinessRolePicker({ selected = [], error }: { selected?: CustomerBusinessRoleCode[]; error?: string }) {
  const [checkedRoles, setCheckedRoles] = useState<CustomerBusinessRoleCode[]>(selected);
  const selectedSet = new Set(checkedRoles);
  const missingRequiredRole = checkedRoles.length === 0;
  return <details
    className={`customer-role-dropdown ${missingRequiredRole ? "is-missing-required" : "is-complete"}${error ? " has-error" : ""}`}
    aria-required="true"
    aria-invalid={missingRequiredRole || Boolean(error)}
  >
    <summary><span>业务身份</span><strong>{checkedRoles.length ? checkedRoles.map(customerBusinessRoleLabel).join("、") : "请选择业务身份"}</strong></summary>
    <div className="customer-role-drawer"><p>可多选，用于发货人、收货人、代理、仓库等业务选择。</p><div className="customer-role-options">
      {customerBusinessRoles.map((item) => <label key={item.code}>
        <input
          type="checkbox"
          name="businessRoles"
          value={item.code}
          checked={selectedSet.has(item.code)}
          onChange={(event) => setCheckedRoles((current) => event.target.checked ? [...current, item.code] : current.filter((code) => code !== item.code))}
        />
        <span>{item.label}</span>
      </label>)}
    </div></div>
    {error && <small className="field-error">{error}</small>}
  </details>;
}

function PickupAddressFields({
  countries,
  provinces,
  cities,
  countryName = "countryCode",
  stateName = "state",
  cityName = "city",
  initialCountry = "",
  initialState = "",
  initialCity = "",
}: {
  countries: { code: string; name: string }[];
  provinces: GeoReference[];
  cities: GeoReference[];
  countryName?: string;
  stateName?: string;
  cityName?: string;
  initialCountry?: string;
  initialState?: string;
  initialCity?: string;
}) {
  const [country, setCountry] = useState(initialCountry);
  const [state, setState] = useState(initialState);
  const [city, setCity] = useState(initialCity);
  const availableProvinces = provinces.filter((item) => item.parent_code === country);
  const availableCities = cities.filter((item) => item.parent_code === state);
  return <>
    <label className="field"><span>国家/地区</span><select name={countryName} value={country} onChange={(event) => { setCountry(event.target.value); setState(""); setCity(""); }} required><option value="">请选择国家/地区</option>{countries.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
    <label className="field"><span>省/州</span><select name={stateName} value={state} onChange={(event) => { setState(event.target.value); setCity(""); }} disabled={!country} required><option value="">{country ? "请选择省/州" : "请先选择国家"}</option>{availableProvinces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
    <label className="field"><span>城市</span><select name={cityName} value={city} onChange={(event) => setCity(event.target.value)} disabled={!state} required><option value="">{state ? "请选择城市" : "请先选择省/州"}</option>{availableCities.map((item) => <option key={item.code} value={item.name}>{item.name}</option>)}</select></label>
  </>;
}
