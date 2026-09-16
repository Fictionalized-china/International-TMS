export type MarkContactType = "business" | "exception" | "emergency";
export type MarkContactScope = "company" | "route" | "warehouse";

export type MarkContactOption = {
  id: string;
  name: string;
  contact_type: MarkContactType;
  phone: string;
  user_id: string | null;
  scope_type: MarkContactScope;
  origin_country: string | null;
  destination_country: string | null;
  destination_warehouse_id: string | null;
  is_default: number;
  sort_order: number;
  department_id: string | null;
  department_name: string;
  position_id: string | null;
  position_name: string;
};

export type MarkContactSnapshot = {
  id: string;
  name: string;
  type: MarkContactType;
  phone: string;
  title?: string;
};

export const markContactTypeLabels: Record<MarkContactType, string> = {
  business: "业务联系",
  exception: "异常联系",
  emergency: "紧急联系",
};

export function parseMarkContactIds(values: readonly FormDataEntryValue[] | readonly string[]) {
  const ids = values.map(String).map((value) => value.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("唛头联系人包含重复项，请重新选择");
  if (ids.length > 3) throw new Error("唛头联系人最多选择 3 人");
  return ids;
}

export function parseMarkContactIdsJson(value:string|null|undefined){
  if(value==null)return null;
  try{
    const parsed=JSON.parse(value);
    return parseMarkContactIds(Array.isArray(parsed)?parsed.map(String):[]);
  }catch{
    return [];
  }
}

export function parseMarkContactSnapshots(value: string | null | undefined): MarkContactSnapshot[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 3).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Partial<MarkContactSnapshot>;
      const type = row.type;
      const name = String(row.name || "").trim();
      const phone = String(row.phone || "").trim();
      const title = String(row.title || "").trim();
      if (!name || !phone || !type || !(type in markContactTypeLabels)) return [];
      return [{ id: String(row.id || ""), name, type, phone, ...(title ? { title } : {}) }];
    });
  } catch {
    return [];
  }
}

export function resolveMarkContactSnapshots(
  value: string | null | undefined,
  legacy: { name: string; phone: string | null | undefined },
): MarkContactSnapshot[] {
  const snapshots = parseMarkContactSnapshots(value);
  if (snapshots !== null) return snapshots;
  const phone = String(legacy.phone || "").trim();
  return phone
    ? [{ id: "legacy", name: legacy.name, type: "business", phone }]
    : [];
}

export function contactAppliesToQuote(contact: MarkContactOption, input: {
  originCountry?: string | null;
  destinationCountry?: string | null;
  destinationWarehouseId?: string | null;
}) {
  if (contact.scope_type === "company") return true;
  if (contact.scope_type === "warehouse") {
    return Boolean(contact.destination_warehouse_id) &&
      contact.destination_warehouse_id === input.destinationWarehouseId;
  }
  return normalize(contact.origin_country) === normalize(input.originCountry) &&
    normalize(contact.destination_country) === normalize(input.destinationCountry);
}

export function recommendedMarkContactIds(contacts: readonly MarkContactOption[], input: {
  salespersonId?: string | null;
  originCountry?: string | null;
  destinationCountry?: string | null;
  destinationWarehouseId?: string | null;
}) {
  const applicable = contacts.filter((contact) => contactAppliesToQuote(contact, input));
  const business = applicable.find((contact) =>
    contact.contact_type === "business" && contact.user_id === input.salespersonId,
  );
  return business ? [business.id] : [];
}

function normalize(value: string | null | undefined) {
  return String(value || "").trim().toLocaleLowerCase();
}
