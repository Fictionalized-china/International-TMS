import { nonNegativeNumberPresent } from "./validation";

// Once an order exists these facts belong to the order, even when null. A
// source quote is an immutable origin, not a fallback for missing corrections.
const orderNativeColumns:Readonly<Record<string,string>>={
  customer_contact_name:"shipper_contact",customer_contact_phone:"shipper_phone",
  mark_contact_ids_json:"mark_contacts_snapshot_json",salesperson_user_id:"salesperson_user_id",
  quote_commercial_user_id:"quote_commercial_user_id",quote_commercial_name_snapshot:"quote_commercial_name_snapshot",customs_clearance_mode:"customs_clearance_mode",
  origin_country:"origin_country",origin_state:"origin_state",origin_city:"origin_city",pickup_address:"origin_address",
  destination_country:"destination_country",destination_state:"destination_state",destination_city:"destination_city",
  destination_warehouse_id:"overseas_warehouse_id",destination_warehouse_note:"overseas_warehouse_address_note",
  cargo_description:"cargo_description",pieces:"pieces",declared_quantity_unit:"declared_quantity_unit",
  planned_package_count:"planned_inbound_package_count",planned_package_type:"planned_inbound_package_type",
  gross_weight_kg:"gross_weight_kg",volume_cbm:"volume_cbm",exit_port:"exit_port",
  transit_locations:"transit_locations",customs_location:"customs_location",domestic_agent:"domestic_agent",
  intake_operations_json:"intake_operations_json",
};
export function orderNativeQuotationFacts(order:Record<string,unknown>,quotation:Record<string,unknown>|null) {
  return {...quotation,...Object.fromEntries(Object.entries(orderNativeColumns).map(([key,column])=>[key,order[column]??null]))};
}

const cargoColumns:Readonly<Record<string,string>>={
  quotation_cargo_description:"cargo_name_cn",quotation_pieces:"declared_quantity",
  quotation_declared_quantity_unit:"declared_unit",quotation_planned_package_count:"package_count",
  quotation_planned_package_type:"package_type",quotation_gross_weight_kg:"gross_weight_per_package_kg",
  quotation_length_cm:"length_cm",quotation_width_cm:"width_cm",quotation_height_cm:"height_cm",
  quotation_volume_cbm:"volume_per_package_cbm",
};
export const cargoNativeFieldKeys=new Set(Object.keys(cargoColumns));
export function cargoNativeFieldPresent(key:string,rows:Record<string,unknown>[],order:Record<string,unknown>) {
  const column=cargoColumns[key];if(!column)return false;
  return rows.length>0&&rows.every(row=>{
    let value=row[column];
    // These are documented pre-existing cargo semantics, not invented facts.
    if(key==="quotation_pieces"&&value==null)value=Number(row.package_count)*Number(row.pieces_per_package);
    if(key==="quotation_declared_quantity_unit"&&value==null)value=order.declared_quantity_unit;
    if(key==="quotation_volume_cbm")return nonNegativeNumberPresent(value);
    if(["quotation_cargo_description","quotation_declared_quantity_unit","quotation_planned_package_type"].includes(key))return typeof value==="string"&&Boolean(value.trim());
    return nonNegativeNumberPresent(value)&&Number(value)>0;
  });
}
