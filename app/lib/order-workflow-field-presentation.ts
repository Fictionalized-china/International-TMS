export const quotationConsignmentPresentationKeys = [
  "quotation_customer_contact_name",
  "quotation_customer_contact_phone",
  "quotation_salesperson_user_id",
  "quotation_customs_clearance_mode",
  "quotation_origin_region",
  "quotation_pickup_address",
  "quotation_destination_region",
  "quotation_destination_warehouse_id",
  "quotation_destination_warehouse_note",
] as const;

export const orderCreationConsignmentPresentationKeys = [
  "customer_id",
  "quotation_id",
  "order_date",
  "business_nature",
  "shipper_customer_id",
  "pickup_address_id",
  "shipper_contact",
  "shipper_phone",
  "origin_country",
  "origin_state",
  "origin_city",
  "origin_address",
  "consignee_name",
  "consignee_contact",
  "consignee_phone",
  "destination_country",
  "destination_state",
  "destination_city",
  "destination_address",
  "overseas_warehouse_id",
  "overseas_warehouse_address_note",
  "requested_pickup_date",
  "cargo_ready_at",
  "requested_delivery_date",
  "ro_agent",
  "special_instructions",
] as const;

export const quotationCargoPresentationKeys = [
  "quotation_cargo_description",
  "quotation_notes",
  "quotation_pieces",
  "quotation_gross_weight_kg",
  "quotation_length_cm",
  "quotation_width_cm",
  "quotation_height_cm",
  "quotation_volume_cbm",
] as const;

export const cargoDetailFieldGroups = [
  {
    label: "品名 / HS",
    fieldKeys: ["cargo_name_cn", "cargo_name_en", "hs_code", "overseas_hs_code"],
  },
  {
    label: "包装",
    fieldKeys: ["package_type", "package_count", "pieces_per_package"],
  },
  {
    label: "重量",
    fieldKeys: ["gross_weight_per_package_kg", "net_weight_per_package_kg"],
  },
  {
    label: "尺寸 / 体积",
    fieldKeys: ["length_cm", "width_cm", "height_cm", "volume_per_package_cbm"],
  },
  {
    label: "货值",
    fieldKeys: ["declared_value", "currency"],
  },
  {
    label: "属性",
    fieldKeys: ["origin_country_cargo", "brand_model", "marks", "special_attributes"],
  },
  {
    label: "图片 / 备注",
    fieldKeys: ["cargo_images", "cargo_notes"],
  },
] as const;

export const quotationCostsPresentationKeys = [
  "quotation_charge_items",
  "quotation_valid_until",
  "pre_receivable_expenses",
] as const;

export const orderWorkflowPresentationKeys = new Set<string>([
  ...quotationConsignmentPresentationKeys,
  ...orderCreationConsignmentPresentationKeys,
  ...quotationCargoPresentationKeys,
  ...cargoDetailFieldGroups.flatMap((group) => group.fieldKeys),
  ...quotationCostsPresentationKeys,
]);

export function workflowFieldsForStep<T extends { stepKey: string }>(
  fields: readonly T[],
  stepKey: string | null | undefined,
): T[] {
  return stepKey ? fields.filter((field) => field.stepKey === stepKey) : [...fields];
}
