import type { QuotationNativeFieldKey } from "./quotation-native-field-catalog";

export type ExistingQuotationCharge = {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  notes: string | null;
  sort_order: number;
};

export type ParsedQuotationCharge = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  notes: string | null;
};

export type QuotationChargeUpdate = {
  charges: ParsedQuotationCharge[];
  changed: boolean;
};

export function parseQuotationChargeUpdate(input: {
  existing: readonly ExistingQuotationCharge[];
  ids: readonly string[];
  names: readonly string[];
  quantities: readonly number[];
  unitPrices: readonly number[];
  notes: readonly string[];
  required: boolean;
}): QuotationChargeUpdate {
  const rowCount = input.names.length;
  if (
    input.ids.length !== rowCount ||
    input.quantities.length !== rowCount ||
    input.unitPrices.length !== rowCount ||
    input.notes.length !== rowCount
  ) {
    throw new Error("费用明细表单不完整，请刷新后重试");
  }

  const normalizedIds = input.ids.map((id) => id.trim());
  const submittedExistingIds = normalizedIds.filter(Boolean);
  if (new Set(submittedExistingIds).size !== submittedExistingIds.length) {
    throw new Error("费用明细包含重复行，请刷新后重试");
  }

  const existingById = new Map(input.existing.map((charge) => [charge.id, charge]));
  const foreignIds = submittedExistingIds.filter((id) => !existingById.has(id));
  if (foreignIds.length) {
    throw new Error("费用明细已发生变化或不属于当前报价，请刷新后重试");
  }

  const submittedIdSet = new Set(submittedExistingIds);
  const omitted = input.existing.filter((charge) => !submittedIdSet.has(charge.id));
  if (omitted.length) {
    throw new Error(`当前页面遗漏了 ${omitted.length} 条已有费用，为避免总额与明细不一致，请刷新后重试`);
  }

  const charges = input.names.map((rawName, index) => {
    const id = normalizedIds[index] || "";
    const name = rawName.trim();
    const quantity = input.quantities[index];
    const unitPrice = input.unitPrices[index];
    const valid = Boolean(name) && Number.isFinite(quantity) && quantity > 0 &&
      Number.isFinite(unitPrice) && unitPrice > 0;
    if (!valid) {
      if (id || input.required) {
        throw new Error(`第 ${index + 1} 条费用的名称、数量或单价无效`);
      }
      return null;
    }
    return {
      id,
      name,
      quantity,
      unitPrice,
      amount: quantity * unitPrice,
      notes: input.notes[index].trim() || null,
    };
  }).filter((charge): charge is ParsedQuotationCharge => charge !== null);

  if (input.required && charges.length === 0) {
    throw new Error("至少填写一条有效的客户应收费用");
  }

  const changed = charges.length !== input.existing.length || charges.some((charge, index) => {
    const previous = charge.id ? existingById.get(charge.id) : null;
    if (!previous) return true;
    return previous.description !== charge.name ||
      Number(previous.quantity) !== charge.quantity ||
      Number(previous.unit_price) !== charge.unitPrice ||
      (previous.notes?.trim() || null) !== charge.notes ||
      Number(previous.sort_order) !== (index + 1) * 10;
  });

  return { charges, changed };
}

const nativeColumns: ReadonlyArray<{
  key: QuotationNativeFieldKey;
  columns: readonly string[];
}> = [
  { key: "quotation_customer_contact_name", columns: ["customer_contact_name"] },
  { key: "quotation_customer_contact_phone", columns: ["customer_contact_phone"] },
  { key: "quotation_salesperson_user_id", columns: ["salesperson_user_id"] },
  { key: "quotation_customs_clearance_mode", columns: ["customs_clearance_mode"] },
  { key: "quotation_origin_region", columns: ["origin_country", "origin_state", "origin_city"] },
  { key: "quotation_pickup_address", columns: ["pickup_address"] },
  { key: "quotation_destination_region", columns: ["destination_country", "destination_state", "destination_city"] },
  { key: "quotation_destination_warehouse_id", columns: ["destination_warehouse_id"] },
  { key: "quotation_destination_warehouse_note", columns: ["destination_warehouse_note"] },
  { key: "quotation_cargo_description", columns: ["cargo_description"] },
  { key: "quotation_notes", columns: ["notes"] },
  { key: "quotation_pieces", columns: ["pieces"] },
  { key: "quotation_gross_weight_kg", columns: ["gross_weight_kg"] },
  { key: "quotation_length_cm", columns: ["estimated_length_cm"] },
  { key: "quotation_width_cm", columns: ["estimated_width_cm"] },
  { key: "quotation_height_cm", columns: ["estimated_height_cm"] },
  { key: "quotation_volume_cbm", columns: ["volume_cbm"] },
  { key: "quotation_valid_until", columns: ["valid_until"] },
];

export function changedQuotationNativeFieldKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return nativeColumns
    .filter((item) => item.columns.some((column) => comparable(before[column]) !== comparable(after[column])))
    .map((item) => item.key);
}

function comparable(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export type QuotationDetailFact = {
  key: QuotationNativeFieldKey;
  label: string;
  value: string;
};

export function quotationDetailFacts(
  quote: Record<string, unknown>,
  visible: (key: QuotationNativeFieldKey, fallback: "required" | "optional") => boolean,
): QuotationDetailFact[] {
  const text = (key: string) => String(quote[key] ?? "").trim();
  const region = (prefix: "origin" | "destination") => [
    text(`${prefix}_country`),
    text(`${prefix}_state`),
    text(`${prefix}_city`),
  ].filter(Boolean).join(" ") || "—";
  const candidates: Array<QuotationDetailFact & { fallback: "required" | "optional" }> = [
    { key: "quotation_origin_region", label: "起运地区", value: region("origin"), fallback: "required" },
    { key: "quotation_destination_region", label: "目的地区", value: region("destination"), fallback: "required" },
    { key: "quotation_pieces", label: "预计件数", value: `${text("pieces") || "0"} 件`, fallback: "required" },
    { key: "quotation_gross_weight_kg", label: "预计重量", value: `${text("gross_weight_kg") || "0"} KG`, fallback: "required" },
    { key: "quotation_volume_cbm", label: "预计体积", value: `${text("volume_cbm") || "0"} CBM`, fallback: "required" },
    { key: "quotation_length_cm", label: "预计长度", value: `${text("estimated_length_cm") || "0"} CM`, fallback: "required" },
    { key: "quotation_width_cm", label: "预计宽度", value: `${text("estimated_width_cm") || "0"} CM`, fallback: "required" },
    { key: "quotation_height_cm", label: "预计高度", value: `${text("estimated_height_cm") || "0"} CM`, fallback: "required" },
  ];
  return candidates
    .filter((fact) => visible(fact.key, fact.fallback))
    .map(({ fallback: _fallback, ...fact }) => fact);
}
