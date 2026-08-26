import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/admin.customers";
import { requireSessionUser } from "../lib/auth.server";
import { hashPassword } from "../lib/crypto.server";
import { validateCode, validateEmail, validatePassword, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { generateCustomerIdentityCode } from "../lib/customer-identity";
import {
  customerBusinessRoleLabel,
  customerBusinessRoles,
  isCustomerBusinessRoleCode,
  legacyCustomerTypeForRoles,
  type CustomerBusinessRoleCode,
} from "../lib/customer-business-roles";

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
  primary_contact_phone: string | null;
  default_address_id: string | null;
  default_address_country_code: string | null;
  default_address_state: string | null;
  default_address_city: string | null;
  default_address_line1: string | null;
};
type ContactRow = { id: string; customer_id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: number };
type AddressRow = { id: string; customer_id: string; label: string; type: string; country_code: string; state: string | null; city: string; address_line1: string; contact_name: string | null; contact_phone: string | null; is_default: number };
type PortalRow = { id: string; customer_id: string; display_name: string; email: string; status: string; last_login_at: string | null };
type ContractRow = { id: string; customer_id: string; title: string; file_name: string; content_type: string; size_bytes: number; effective_at: string | null; expires_at: string | null; status: string; notes: string | null; created_at: string };
type GeoReference = { code: string; name: string; parent_code: string | null };
type CustomerDefaultProfile = {
  contactName: string;
  contactPhone: string;
  addressCountryCode: string;
  addressState: string;
  addressCity: string;
  addressLine1: string;
};

function customerDefaultProfile(form: FormData): CustomerDefaultProfile {
  return {
    contactName: valueOf(form, "contactName"),
    contactPhone: valueOf(form, "contactPhone"),
    addressCountryCode: valueOf(form, "addressCountryCode"),
    addressState: valueOf(form, "addressState"),
    addressCity: valueOf(form, "addressCity"),
    addressLine1: valueOf(form, "addressLine1"),
  };
}

async function validateCustomerDefaultProfile(profile: CustomerDefaultProfile, organizationId: string) {
  if (profile.contactName.length < 2) return "默认联系人姓名至少 2 个字符";
  if (!profile.contactPhone || profile.contactPhone.length > 30) return "请填写有效的默认联系人电话";
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
  const [customers, contacts, addresses, portals, contracts, owners, countries, provinces, cities] = await Promise.all([
    env.DB.prepare(`SELECT c.id, c.code, c.identity_code, c.name, c.short_name, COALESCE(c.party_category,'customer') AS party_category, c.status, c.notes, c.sales_owner_user_id, u.display_name AS sales_owner_name, COALESCE(GROUP_CONCAT(DISTINCT cbr.role_code), '') AS business_role_codes, COUNT(DISTINCT cc.id) AS contact_count, COUNT(DISTINCT ca.id) AS address_count,
      (SELECT x.id FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_id,
      (SELECT x.name FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_name,
      (SELECT x.phone FROM customer_contacts x WHERE x.customer_id=c.id ORDER BY x.is_primary DESC,x.updated_at DESC LIMIT 1) AS primary_contact_phone,
      (SELECT x.id FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_id,
      (SELECT x.country_code FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_country_code,
      (SELECT x.state FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_state,
      (SELECT x.city FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_city,
      (SELECT x.address_line1 FROM customer_addresses x WHERE x.customer_id=c.id AND x.type='shipping' ORDER BY x.is_default DESC,x.updated_at DESC LIMIT 1) AS default_address_line1
      FROM customers c LEFT JOIN users u ON u.id = c.sales_owner_user_id LEFT JOIN customer_contacts cc ON cc.customer_id = c.id LEFT JOIN customer_addresses ca ON ca.customer_id = c.id LEFT JOIN customer_business_role_assignments cbr ON cbr.customer_id = c.id AND cbr.organization_id = c.organization_id WHERE c.organization_id = ? GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`).bind(current.organizationId).all<CustomerRow>(),
    env.DB.prepare(`SELECT cc.id, cc.customer_id, cc.name, cc.title, cc.email, cc.phone, cc.is_primary FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id WHERE c.organization_id = ? AND cc.customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY cc.is_primary DESC, cc.name`).bind(current.organizationId,current.organizationId).all<ContactRow>(),
    env.DB.prepare(`SELECT ca.id, ca.customer_id, ca.label, ca.type, ca.country_code, ca.state, ca.city, ca.address_line1, ca.contact_name, ca.contact_phone, ca.is_default FROM customer_addresses ca JOIN customers c ON c.id = ca.customer_id WHERE c.organization_id = ? AND ca.customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY ca.is_default DESC, ca.label`).bind(current.organizationId,current.organizationId).all<AddressRow>(),
    env.DB.prepare(`SELECT cpa.id, cpa.customer_id, u.display_name, u.email, cpa.status, u.last_login_at FROM customer_portal_accounts cpa JOIN users u ON u.id = cpa.user_id WHERE cpa.organization_id = ? AND cpa.customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY u.display_name`).bind(current.organizationId,current.organizationId).all<PortalRow>(),
    env.DB.prepare(`SELECT id, customer_id, title, file_name, content_type, size_bytes, effective_at, expires_at, status, notes, created_at FROM customer_contracts WHERE organization_id = ? AND customer_id IN (SELECT id FROM customers WHERE organization_id=? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at DESC LIMIT 500`).bind(current.organizationId,current.organizationId).all<ContractRow>(),
    env.DB.prepare(`SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.status = 'active' ORDER BY u.display_name`).bind(current.organizationId).all<{ id: string; display_name: string }>(),
    env.DB.prepare("SELECT code, name FROM reference_data WHERE organization_id = ? AND category = 'country' AND status = 'active' ORDER BY sort_order, code").bind(current.organizationId).all<{ code: string; name: string }>(),
    env.DB.prepare("SELECT code, name, parent_code FROM reference_data WHERE organization_id = ? AND category = 'province' AND status = 'active' ORDER BY sort_order, code").bind(current.organizationId).all<GeoReference>(),
    env.DB.prepare("SELECT code, name, parent_code FROM reference_data WHERE organization_id = ? AND category = 'city' AND status = 'active' ORDER BY sort_order, code").bind(current.organizationId).all<GeoReference>(),
  ]);
  return { current, customers: customers.results, contacts: contacts.results, addresses: addresses.results, portals: portals.results, contracts: contracts.results, owners: owners.results, countries: countries.results, provinces: provinces.results, cities: cities.results };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "customer.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (intent === "contact") {
    const customerId = valueOf(form, "customerId"), name = valueOf(form, "name"), title = valueOf(form, "title"), email = valueOf(form, "email").toLowerCase(), phone = valueOf(form, "phone");
    if (!(await ownedCustomer(customerId, current.organizationId))) return { formError: "客户不存在" };
    if (name.length < 2) return { formError: "联系人姓名至少 2 个字符" };
    if (email && validateEmail(email)) return { formError: "联系人邮箱格式不正确" };
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO customer_contacts (id, customer_id, name, title, email, phone, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, customerId, name, title || null, email || null, phone || null, form.has("isPrimary") ? 1 : 0, now, now).run();
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
    const profile = customerDefaultProfile(form);
    const submittedRoles = [...new Set(form.getAll("businessRoles").map(String))];
    const businessRoles = submittedRoles.filter(isCustomerBusinessRoleCode);
    const errors: Record<string, string> = {};
    const codeError = validateCode(code);
    if (!(await ownedCustomer(customerId, current.organizationId))) errors.customerId = "客户不存在";
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
    const [existingContact, existingAddress] = await Promise.all([
      env.DB.prepare("SELECT id FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC,updated_at DESC LIMIT 1").bind(customerId).first<{ id: string }>(),
      env.DB.prepare("SELECT id FROM customer_addresses WHERE customer_id=? AND type='shipping' ORDER BY is_default DESC,updated_at DESC LIMIT 1").bind(customerId).first<{ id: string }>(),
    ]);
    const contactId = existingContact?.id || crypto.randomUUID();
    const addressId = existingAddress?.id || crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE customers SET code=?,name=?,short_name=?,party_category=?,type=?,sales_owner_user_id=?,status=?,notes=?,updated_at=? WHERE id=? AND organization_id=?")
          .bind(code, name, shortName || null, partyCategory, legacyCustomerTypeForRoles(businessRoles), ownerId || null, status, notes || null, now, customerId, current.organizationId),
        env.DB.prepare("DELETE FROM customer_business_role_assignments WHERE organization_id=? AND customer_id=?").bind(current.organizationId, customerId),
        ...businessRoles.map((roleCode) => env.DB.prepare("INSERT INTO customer_business_role_assignments(id,organization_id,customer_id,role_code,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), current.organizationId, customerId, roleCode, now)),
        env.DB.prepare("UPDATE customer_contacts SET is_primary=0,updated_at=? WHERE customer_id=?").bind(now, customerId),
        existingContact
          ? env.DB.prepare("UPDATE customer_contacts SET name=?,phone=?,is_primary=1,updated_at=? WHERE id=? AND customer_id=?")
              .bind(profile.contactName, profile.contactPhone, now, contactId, customerId)
          : env.DB.prepare("INSERT INTO customer_contacts(id,customer_id,name,phone,is_primary,created_at,updated_at) VALUES(?,?,?,?,1,?,?)")
              .bind(contactId, customerId, profile.contactName, profile.contactPhone, now, now),
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
    await writeAudit({ request, action: "customer.update", resourceType: "customer", resourceId: customerId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { code, partyCategory, businessRoles, status } });
    return { success: `客户“${name}”已更新` };
  }

  const code = valueOf(form, "code").toLowerCase(), name = valueOf(form, "name"), shortName = valueOf(form, "shortName"), partyCategory = valueOf(form, "partyCategory"), ownerId = valueOf(form, "ownerId"), notes = valueOf(form, "notes"), profile = customerDefaultProfile(form);
  const submittedRoles = [...new Set(form.getAll("businessRoles").map(String))];
  const businessRoles = submittedRoles.filter(isCustomerBusinessRoleCode);
  const errors: Record<string, string> = {};
  const codeError = validateCode(code); if (codeError) errors.code = codeError;
  if (name.length < 2 || name.length > 120) errors.name = "客户名称需要 2-120 个字符";
  if (!isCustomerPartyCategory(partyCategory)) errors.partyCategory = "请选择客商分类";
  if (!businessRoles.length || businessRoles.length !== submittedRoles.length) errors.businessRoles = "请至少选择一个有效的业务身份";
  if (ownerId && !(await env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'").bind(ownerId, current.organizationId).first())) errors.ownerId = "销售负责人无效";
  const profileError = await validateCustomerDefaultProfile(profile, current.organizationId);
  if (profileError) errors.profile = profileError;
  if (Object.keys(errors).length) return { errors, values: { code, name, shortName, partyCategory, businessRoles, ownerId, notes, ...profile } };
  const id = crypto.randomUUID(), identityCode = await nextCustomerIdentityCode(current.organizationId);
  if (!identityCode) return { formError: "暂时无法生成客户识别码，请重试", values: { code, name, shortName, partyCategory, businessRoles, ownerId, notes, ...profile } };
  const contactId = crypto.randomUUID(), addressId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO customers (id, organization_id, code, identity_code, name, short_name, party_category, type, sales_owner_user_id, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(id, current.organizationId, code, identityCode, name, shortName || null, partyCategory, legacyCustomerTypeForRoles(businessRoles), ownerId || null, notes || null, now, now),
      ...businessRoles.map((roleCode) => env.DB.prepare("INSERT INTO customer_business_role_assignments(id,organization_id,customer_id,role_code,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), current.organizationId, id, roleCode, now)),
      env.DB.prepare("INSERT INTO customer_contacts(id,customer_id,name,phone,is_primary,created_at,updated_at) VALUES(?,?,?,?,1,?,?)")
        .bind(contactId, id, profile.contactName, profile.contactPhone, now, now),
      env.DB.prepare("INSERT INTO customer_addresses(id,customer_id,type,label,country_code,state,city,address_line1,contact_name,contact_phone,is_default,created_at,updated_at) VALUES(?,?,'shipping','默认提货地',?,?,?,?,?,?,1,?,?)")
        .bind(addressId, id, profile.addressCountryCode, profile.addressState, profile.addressCity, profile.addressLine1, profile.contactName, profile.contactPhone, now, now),
    ]);
  } catch { return { formError: "客户代码或识别码不能重复", values: { code, name, shortName, partyCategory, businessRoles, ownerId, notes, ...profile } }; }
  await writeAudit({ request, action: "customer.create", resourceType: "customer", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { code, identityCode, partyCategory, businessRoles } });
  return { success: "客户已创建" };
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

export default function Customers({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle", canManage = loaderData.current.permissions.includes("customer.manage");
  const submittedValues = actionData && "values" in actionData ? actionData.values : undefined;
  const submittedErrors = actionData && "errors" in actionData ? actionData.errors : undefined;
  const submittedCustomerId = submittedValues && "customerId" in submittedValues ? submittedValues.customerId : undefined;
  return <>
    <header className="page-header">
      <div><p className="eyebrow">CUSTOMER 360</p><h1>客户管理</h1><p>统一维护客商分类、业务身份、联系人、常用地址和门户账号。</p></div>
      <span className="status-pill">{loaderData.customers.length} 家客商</span>
    </header>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    <section className="panel">
      <div className="panel-header">
        <div><h2>客户列表</h2><p>共 {loaderData.customers.length} 家客商</p></div>
        {canManage && <Modal title="新增客户" triggerLabel="新增客户" size="wide" closeSignal={actionData?.success}>
          <CustomerForm
            intent="customer"
            owners={loaderData.owners}
            countries={loaderData.countries}
            provinces={loaderData.provinces}
            cities={loaderData.cities}
            busy={busy}
            values={submittedCustomerId ? undefined : submittedValues}
            errors={submittedCustomerId ? undefined : submittedErrors}
          />
        </Modal>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>识别码</th><th>客户代码/名称</th><th>客商分类</th><th>业务身份</th><th>销售负责人</th><th>联系人/地址</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{loaderData.customers.map((customer) => {
            const roles = customer.business_role_codes.split(",").filter(Boolean) as CustomerBusinessRoleCode[];
            const editValues = submittedCustomerId === customer.id ? submittedValues : undefined;
            return <tr key={customer.id}>
              <td><code className="identity-code">{customer.identity_code}</code></td>
              <td><strong>{customer.name}</strong><small>{customer.code}{customer.short_name ? ` · ${customer.short_name}` : ""}</small></td>
              <td><span className="status-pill neutral">{customerPartyCategoryLabel(customer.party_category)}</span></td>
              <td><div className="customer-role-tags">{roles.map((role) => <span key={role}>{customerBusinessRoleLabel(role)}</span>)}</div></td>
              <td>{customer.sales_owner_name || "未指定"}</td>
              <td><strong>{customer.contact_count} 人</strong><small>{customer.address_count} 个地址</small></td>
              <td><span className={`status-pill ${customer.status !== "active" ? "off" : ""}`}>{customer.status === "active" ? "正常" : customer.status === "suspended" ? "暂停" : "归档"}</span></td>
              <td>{canManage && <Modal title={`编辑客户 · ${customer.name}`} triggerLabel="编辑" triggerClassName="text-button" size="wide" closeSignal={actionData?.success}>
                <CustomerForm
                  intent="customer_update"
                  customer={customer}
                  owners={loaderData.owners}
                  countries={loaderData.countries}
                  provinces={loaderData.provinces}
                  cities={loaderData.cities}
                  busy={busy}
                  values={editValues}
                  errors={editValues ? submittedErrors : undefined}
                  selectedRoles={roles}
                />
              </Modal>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!loaderData.customers.length && <p className="empty-state">暂无客户，请点击右上角“新增客户”。</p>}
    </section>
    {canManage && loaderData.customers.length > 0 && <section className="action-grid"><details className="panel expandable"><summary>归档客户合同</summary><Form method="post" className="stack" encType="multipart/form-data"><input type="hidden" name="intent" value="contract_upload"/><CustomerSelect customers={loaderData.customers}/><label className="field"><span>合同名称</span><input name="title" required placeholder="2026 年度运输框架合同"/></label><label className="field"><span>合同文件（≤1.2MB）</span><input name="attachment" type="file" required accept="image/*,application/pdf"/></label><label className="field"><span>生效日期</span><input name="effectiveAt" type="date"/></label><label className="field"><span>到期日期</span><input name="expiresAt" type="date"/></label><label className="field"><span>备注</span><input name="notes" placeholder="合同编号、签署方等"/></label><button className="primary" disabled={busy}>上传并归档合同</button><small className="field-hint">合同统一归档在客户资料页，订单工作流不再要求逐单上传合同。</small></Form></details><details className="panel expandable"><summary>添加联系人</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="contact"/><CustomerSelect customers={loaderData.customers}/><label className="field"><span>姓名</span><input name="name" required/></label><label className="field"><span>职务</span><input name="title"/></label><label className="field"><span>邮箱</span><input name="email" type="email"/></label><label className="field"><span>电话</span><input name="phone"/></label><label className="check-field"><input name="isPrimary" type="checkbox"/>主要联系人</label><button className="primary" disabled={busy}>添加联系人</button></Form></details><details className="panel expandable"><summary>添加常用地址</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="address"/><CustomerSelect customers={loaderData.customers}/><label className="field"><span>地址名称</span><input name="label" required placeholder="上海仓库"/></label><label className="field"><span>类型</span><select name="type"><option value="shipping">收发货</option><option value="warehouse">仓库</option><option value="billing">账单</option><option value="registered">注册地址</option></select></label><label className="field"><span>国家/地区</span><select name="countryCode">{loaderData.countries.map(item => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label><label className="field"><span>城市</span><input name="city" required/></label><label className="field"><span>详细地址</span><input name="addressLine1" required/></label><label className="check-field"><input name="isDefault" type="checkbox"/>默认地址</label><button className="primary" disabled={busy}>添加地址</button></Form></details><details className="panel expandable pickup-address-panel"><summary>添加常用提货地</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="pickup_address"/><CustomerSelect customers={loaderData.customers}/><label className="field"><span>提货地名称</span><input name="label" required placeholder="深圳工厂"/></label><PickupAddressFields countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities}/><label className="field"><span>详细地址</span><input name="addressLine1" required placeholder="街道、门牌号、园区和楼栋"/></label><label className="field"><span>提货联系人</span><input name="contactName"/></label><label className="field"><span>联系电话</span><input name="contactPhone"/></label><label className="check-field"><input name="isDefault" type="checkbox"/>设为该客户默认提货地</label><button className="primary" disabled={busy}>保存常用提货地</button></Form></details><details className="panel expandable"><summary>开通客户门户</summary><Form method="post" className="stack"><input type="hidden" name="intent" value="portal"/><CustomerSelect customers={loaderData.customers}/><label className="field"><span>用户姓名</span><input name="displayName" required/></label><label className="field"><span>登录邮箱</span><input name="email" type="email" required/></label><label className="field"><span>初始密码</span><input name="password" type="password" required/><small>至少 12 位，包含大小写字母和数字</small></label><button className="primary" disabled={busy}>开通门户</button></Form></details></section>}
    <section className="panel"><h2>客户档案明细</h2><div className="table-wrap"><table><thead><tr><th>客户</th><th>联系人</th><th>常用地址</th><th>门户用户</th><th>合同归档</th></tr></thead><tbody>{loaderData.customers.map(customer => {
      const contracts = loaderData.contracts.filter(item => item.customer_id === customer.id);
      const activeContracts = contracts.filter(item => item.status === "active");
      return <tr key={customer.id}><td><strong>{customer.name}</strong><small>{customer.code}</small></td><td>{loaderData.contacts.filter(item => item.customer_id === customer.id).map(item => <div key={item.id}><strong>{item.name}{item.is_primary ? " · 主要" : ""}</strong><small>{item.email || item.phone || "—"}</small></div>)}</td><td>{loaderData.addresses.filter(item => item.customer_id === customer.id).map(item => <div key={item.id}><strong>{item.label}</strong><small>{item.country_code} {item.city} {item.address_line1}</small></div>)}</td><td>{loaderData.portals.filter(item => item.customer_id === customer.id).map(item => <div key={item.id}><strong>{item.display_name}</strong><small>{item.email}</small></div>)}</td><td>{activeContracts.length ? activeContracts.map(item => <div key={item.id} className="customer-contract-row"><div><strong>{item.title}</strong><small>{item.effective_at ? `${item.effective_at} 生效` : "生效日期未填"}{item.expires_at ? ` · ${item.expires_at} 到期` : ""}{item.notes ? ` · ${item.notes}` : ""}</small></div><div className="customer-contract-actions"><a className="text-button" href={`/admin/customer-contracts/${item.id}/download`}>下载</a>{canManage && item.status === "active" && <Form method="post" className="inline-form"><input type="hidden" name="intent" value="contract_archive"/><input type="hidden" name="contractId" value={item.id}/><button className="text-button" disabled={busy}>归档</button></Form>}</div></div>) : <small>暂无合同</small>}{contracts.length > activeContracts.length && <small>另有 {contracts.length - activeContracts.length} 份已归档</small>}</td></tr>;
    })}</tbody></table></div></section>
  </>;
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
  selectedRoles?: CustomerBusinessRoleCode[];
}) {
  const editing = intent === "customer_update";
  const roles = values?.businessRoles ?? selectedRoles;
  return <Form method="post" className="form-grid compact customer-editor-form">
    <input type="hidden" name="intent" value={intent} />
    {customer && <input type="hidden" name="customerId" value={customer.id} />}
    <label className="field"><span>客户代码</span><input name="code" required placeholder="ouling-client" defaultValue={values?.code ?? customer?.code}/>{errors?.code && <small className="field-error">{errors.code}</small>}</label>
    <label className="field"><span>客户识别码</span><input value={customer?.identity_code ?? "创建后自动生成"} disabled/><small>{editing ? "系统识别码不可修改" : "5 位字母与数字组合，排除 O、0、1、L"}</small></label>
    <label className="field"><span>客户全称</span><input name="name" required defaultValue={values?.name ?? customer?.name}/>{errors?.name && <small className="field-error">{errors.name}</small>}</label>
    <label className="field"><span>客户简称</span><input name="shortName" defaultValue={values?.shortName ?? customer?.short_name ?? ""}/></label>
    <label className="field"><span>客商分类</span><select name="partyCategory" required defaultValue={values?.partyCategory ?? customer?.party_category ?? "customer"}><option value="">请选择</option>{customerPartyCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{errors?.partyCategory && <small className="field-error">{errors.partyCategory}</small>}</label>
    <label className="field"><span>销售负责人</span><select name="ownerId" defaultValue={values?.ownerId ?? customer?.sales_owner_user_id ?? ""}><option value="">未指定</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.display_name}</option>)}</select>{errors?.ownerId && <small className="field-error">{errors.ownerId}</small>}</label>
    <CustomerBusinessRolePicker selected={roles} error={errors?.businessRoles}/>
    <fieldset className="customer-profile-fields span-2">
      <legend>默认联系人</legend>
      <p>报价接受并自动建单后，补充委托资料时可直接选择并带入联系电话。</p>
      <div className="form-grid compact">
        <label className="field"><span>联系人名称 <b aria-hidden="true">*</b></span><input name="contactName" required defaultValue={values?.contactName ?? customer?.primary_contact_name ?? ""} placeholder="请输入联系人姓名" /></label>
        <label className="field"><span>联系人电话 <b aria-hidden="true">*</b></span><input name="contactPhone" required defaultValue={values?.contactPhone ?? customer?.primary_contact_phone ?? ""} placeholder="请输入联系电话" /></label>
      </div>
    </fieldset>
    <fieldset className="customer-profile-fields span-2">
      <legend>默认提货地址</legend>
      <p>报价接受并自动建单后，补充委托资料时自动带入，也可改选其他常用地址或手工输入。</p>
      <div className="form-grid compact">
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
        <label className="field span-2"><span>详细地址 <b aria-hidden="true">*</b></span><input name="addressLine1" required defaultValue={values?.addressLine1 ?? customer?.default_address_line1 ?? ""} placeholder="街道、门牌号、园区和楼栋" /></label>
      </div>
      {errors?.profile && <small className="field-error">{errors.profile}</small>}
    </fieldset>
    {editing && <label className="field"><span>状态</span><select name="status" required defaultValue={values?.status ?? customer?.status ?? "active"}><option value="active">正常</option><option value="suspended">暂停</option><option value="archived">归档</option></select>{errors?.status && <small className="field-error">{errors.status}</small>}</label>}
    <label className={`field ${editing ? "" : "span-2"}`}><span>备注</span><textarea name="notes" rows={3} defaultValue={values?.notes ?? customer?.notes ?? ""}/></label>
    <button className="primary span-2" disabled={busy}>{editing ? "保存客户信息" : "创建客户"}</button>
  </Form>;
}

function CustomerBusinessRolePicker({ selected = [], error }: { selected?: CustomerBusinessRoleCode[]; error?: string }) {
  const selectedSet = new Set(selected);
  return <fieldset className="customer-role-picker span-2" aria-required="true">
    <legend>业务身份 <b aria-hidden="true">*</b></legend>
    <p>可多选；用于发货人、收货人、代理、仓库等业务下拉选择。</p>
    <div className="customer-role-options">
      {customerBusinessRoles.map((item) => <label key={item.code}>
        <input type="checkbox" name="businessRoles" value={item.code} defaultChecked={selectedSet.has(item.code)} />
        <span>{item.label}</span>
      </label>)}
    </div>
    {error && <small className="field-error">{error}</small>}
  </fieldset>;
}

function CustomerSelect({ customers }: { customers: CustomerRow[] }) {
  return <label className="field"><span>客户</span><select name="customerId" required><option value="">请选择</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.code} · {customer.name}</option>)}</select></label>;
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
    <label className="field"><span>国家/地区 <b aria-hidden="true">*</b></span><select name={countryName} value={country} onChange={(event) => { setCountry(event.target.value); setState(""); setCity(""); }} required><option value="">请选择国家/地区</option>{countries.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
    <label className="field"><span>省/州 <b aria-hidden="true">*</b></span><select name={stateName} value={state} onChange={(event) => { setState(event.target.value); setCity(""); }} disabled={!country} required><option value="">{country ? "请选择省/州" : "请先选择国家"}</option>{availableProvinces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
    <label className="field"><span>城市 <b aria-hidden="true">*</b></span><select name={cityName} value={city} onChange={(event) => setCity(event.target.value)} disabled={!state} required><option value="">{state ? "请选择城市" : "请先选择省/州"}</option>{availableCities.map((item) => <option key={item.code} value={item.name}>{item.name}</option>)}</select></label>
  </>;
}
