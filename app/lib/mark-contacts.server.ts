import { env } from "cloudflare:workers";
import {
  contactAppliesToQuote,
  type MarkContactOption,
  type MarkContactSnapshot,
} from "./mark-contacts";

export async function listActiveMarkContacts(organizationId: string) {
  const rows = await env.DB.prepare(
    `SELECT u.id,u.display_name name,'business' contact_type,u.phone,u.id user_id,
            'company' scope_type,NULL origin_country,NULL destination_country,
            NULL destination_warehouse_id,0 is_default,
            COALESCE(d.sort_order,9999)*1000+COALESCE(p.sort_order,999) sort_order,
            d.id department_id,COALESCE(d.name,'未分配部门') department_name,
            p.id position_id,COALESCE(p.name,m.title,'未分配岗位') position_name
       FROM memberships m
       JOIN users u ON u.id=m.user_id AND u.status='active'
       LEFT JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id
       LEFT JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.status='active' AND TRIM(COALESCE(u.phone,''))<>''
      ORDER BY COALESCE(d.sort_order,9999),COALESCE(p.sort_order,999),u.display_name`,
  ).bind(organizationId).all<MarkContactOption>();
  return rows.results ?? [];
}

export async function resolveMarkContactSnapshots(input: {
  organizationId: string;
  ids: readonly string[];
  originCountry?: string | null;
  destinationCountry?: string | null;
  destinationWarehouseId?: string | null;
}) {
  if (!input.ids.length) return [];
  const contacts = await listActiveMarkContacts(input.organizationId);
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const selected = input.ids.map((id) => byId.get(id));
  if (selected.some((contact) => !contact)) {
    throw new Error("所选唛头联系人已停用、无权外显或不存在，请重新选择");
  }
  const resolved = selected as MarkContactOption[];
  if (resolved.some((contact) => !contactAppliesToQuote(contact, input))) {
    throw new Error("所选唛头联系人不适用于当前线路或目的仓，请重新选择");
  }
  return resolved.map<MarkContactSnapshot>((contact) => ({
    id: contact.id,
    name: contact.name,
    type: contact.contact_type,
    phone: contact.phone,
    title: contact.position_name,
  }));
}
