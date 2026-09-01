import type { OrderModuleCode } from "./order-modules";

export type QuotationNativeFieldMode = "required" | "optional" | "hidden";

export type QuotationNativeFieldDefinition = {
  fieldKey: string;
  label: string;
  fieldType: string;
  moduleCode: OrderModuleCode;
  defaultMode: QuotationNativeFieldMode;
  helpText: string;
  optionsText?: string;
};

const nativeField = (
  fieldKey: string,
  label: string,
  fieldType: string,
  moduleCode: OrderModuleCode,
  defaultMode: QuotationNativeFieldMode,
  helpText: string,
  optionsText?: string,
): QuotationNativeFieldDefinition => ({
  fieldKey,label,fieldType,moduleCode,defaultMode,helpText,optionsText,
});

// Single source of truth for standard inputs owned by the quotation table/UI.
// Customer, transport mode, road-load type and workflow version are selection
// prerequisites used before a workflow can be resolved, so they stay outside
// this configurable list.
export const quotationNativeFieldCatalog = [
  nativeField("quotation_customer_contact_name","客户联系人","text","consignment","required","本次报价的客户联系人；默认带出客户档案的主联系人。"),
  nativeField("quotation_customer_contact_phone","联系电话","text","consignment","required","本次报价联系人电话。"),
  nativeField("quotation_salesperson_user_id","业务员","select","consignment","required","负责本次询价与报价的业务员；未显示时默认当前操作人。"),
  nativeField("quotation_customs_clearance_mode","清关办理方式","select","consignment","required","选择公司代办清关或客户自理清关。","company|公司代办清关\ncustomer|客户自理清关"),
  nativeField("quotation_origin_region","起运地区","select","consignment","required","按国家或地区、省或州、城市三级选择起运地区。"),
  nativeField("quotation_pickup_address","提货地址","textarea","consignment","required","本次报价使用的详细提货地址，可不写入客户常用地址。"),
  nativeField("quotation_destination_region","目的地区","select","consignment","required","按国家或地区、省或州、城市三级选择目的地区。"),
  nativeField("quotation_destination_warehouse_id","目的仓库","warehouse","consignment","required","本次报价的境外目的仓。"),
  nativeField("quotation_destination_warehouse_note","目的地备注","textarea","consignment","optional","门牌、联系人、提货窗口等本票补充说明。"),
  nativeField("quotation_cargo_description","货物描述","textarea","cargo","required","货物名称、品类、材质、用途等报价说明。"),
  nativeField("quotation_notes","报价备注","textarea","cargo","optional","报价范围、特殊约定或其他说明。"),
  nativeField("quotation_pieces","预计件数","number","cargo","required","本次报价预计货物件数。"),
  nativeField("quotation_gross_weight_kg","预计重量 KG","number","cargo","required","本次报价预计毛重。"),
  nativeField("quotation_length_cm","预计长度 CM","number","cargo","required","单件或统一包装预计长度。"),
  nativeField("quotation_width_cm","预计宽度 CM","number","cargo","required","单件或统一包装预计宽度。"),
  nativeField("quotation_height_cm","预计高度 CM","number","cargo","required","单件或统一包装预计高度。"),
  nativeField("quotation_volume_cbm","预计体积 CBM","number","cargo","required","根据件数和长宽高自动计算；也参与报价接受前门禁。"),
  nativeField("quotation_charge_items","客户应收费用","amount","costs","required","至少一条数量和单价均有效的客户应收费用。"),
  nativeField("quotation_valid_until","报价有效期","date","costs","optional","客户接受报价的有效截止日期。"),
] as const satisfies readonly QuotationNativeFieldDefinition[];

export type QuotationNativeFieldKey =
  (typeof quotationNativeFieldCatalog)[number]["fieldKey"];

export const quotationNativeFieldKeySet: ReadonlySet<string> = new Set(
  quotationNativeFieldCatalog.map((field) => field.fieldKey),
);

export function quotationNativeFieldPresent(
  fieldKey: string,
  quotation: Record<string, unknown>,
) {
  const text = (key: string) => String(quotation[key] ?? "").trim().length > 0;
  const positive = (key: string) => Number(quotation[key] ?? 0) > 0;
  switch (fieldKey) {
    case "quotation_customer_contact_name": return text("customer_contact_name");
    case "quotation_customer_contact_phone": return text("customer_contact_phone");
    case "quotation_salesperson_user_id": return text("salesperson_user_id");
    case "quotation_customs_clearance_mode": return text("customs_clearance_mode");
    case "quotation_origin_region":
      return text("origin_country") && text("origin_state") && text("origin_city");
    case "quotation_pickup_address": return text("pickup_address");
    case "quotation_destination_region":
      return text("destination_country") && text("destination_state") && text("destination_city");
    case "quotation_destination_warehouse_id": return text("destination_warehouse_id");
    case "quotation_destination_warehouse_note": return text("destination_warehouse_note");
    case "quotation_cargo_description": return text("cargo_description");
    case "quotation_notes": return text("notes");
    case "quotation_pieces": return positive("pieces");
    case "quotation_gross_weight_kg": return positive("gross_weight_kg");
    case "quotation_length_cm": return positive("estimated_length_cm");
    case "quotation_width_cm": return positive("estimated_width_cm");
    case "quotation_height_cm": return positive("estimated_height_cm");
    case "quotation_volume_cbm": return positive("volume_cbm");
    case "quotation_charge_items": return positive("quotation_charge_items");
    case "quotation_valid_until": return text("valid_until");
    default: return false;
  }
}
