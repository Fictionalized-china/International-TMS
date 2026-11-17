import { describe,expect,it } from "vitest";
import { intakeOperationFields,intakeOperationFieldKey } from "./intake-operations";
import {
  quotationNativeFieldCatalog,
  quotationNativeFieldKeySet,
  quotationNativeFieldPresent,
} from "./quotation-native-field-catalog";
import { workflowFieldCatalog } from "./workflow-field-catalog";
import {
  activeQuotationCustomWorkflowFields,
  quotationBuiltInWorkflowFieldKeys,
  quotationWorkflowFieldPolicy,
  type QuotationWorkflowField,
} from "./quotation-workflow-fields";

describe("quotation native workflow fields",() => {
  it("retains a genuine historical commercial name snapshot after its user identity was deleted",()=>{
    expect(quotationNativeFieldPresent("quotation_quote_commercial_user_id",{quote_commercial_user_id:null,quote_commercial_name_snapshot:"历史报价人"})).toBe(true);
    expect(quotationNativeFieldPresent("quotation_quote_commercial_user_id",{quote_commercial_user_id:null,quote_commercial_name_snapshot:"  "})).toBe(false);
  });
  it.each([
    ["headVehicleCount",0],["headVehicleCount",1.5],["headVehicleCount","1"],
    ["headCarrier",{}],["headCarrier","  "],["headCarrier","x\u0000"],
    ["businessAssistant",{id:"",display_name:"伪造姓名"}],
    ["businessAssistant",{id:"sales",display_name:""}],
    ["entrustedServices",["not-a-service"]],
    ["plannedDeparture","2026-02-30T01:00:00Z"],
  ])("does not mistake an invalid planned fact %s=%j for completeness",(key,value)=>{
    expect(quotationNativeFieldPresent(intakeOperationFieldKey(key as typeof intakeOperationFields[number]["key"]),{intake_operations_json:JSON.stringify({[key]:value})})).toBe(false);
  });
  it("rejects a backwards arrival even when both individual dates have values",()=>{
    expect(quotationNativeFieldPresent("quotation_intake_plannedArrival",{intake_operations_json:JSON.stringify({plannedDeparture:"2026-11-12T00:00:00Z",plannedArrival:"2026-11-10T00:00:00Z"})})).toBe(false);
  });
  it.each([Infinity,true,"Infinity"])("rejects invalid positive numeric fact %s",pieces=>{
    expect(quotationNativeFieldPresent("quotation_pieces",{pieces})).toBe(false);
  });
  it.each([0, "0", 0.0000001])("treats entered volume %s as present, not a positive-only gate", (volume_cbm) => {
    expect(quotationNativeFieldPresent("quotation_volume_cbm", { volume_cbm })).toBe(true);
  });

  it.each([null, undefined, "", "  ", -1, "invalid", Infinity])("rejects missing or invalid volume %s", (volume_cbm) => {
    expect(quotationNativeFieldPresent("quotation_volume_cbm", { volume_cbm })).toBe(false);
  });

  it("derives every quote workflow surface from one unique native-field registry",() => {
    const keys = quotationNativeFieldCatalog.map((field) => field.fieldKey);
    expect(keys).toHaveLength(39);
    expect(keys).toEqual(expect.arrayContaining(['quotation_intake_businessMajor','quotation_intake_businessKind']));
    expect(new Set(keys).size).toBe(keys.length);
    expect([...quotationBuiltInWorkflowFieldKeys]).toEqual(keys);
    expect([...quotationNativeFieldKeySet]).toEqual(keys);
    expect(
      workflowFieldCatalog
        .filter((field) => field.stepKey === "quotation")
        .map((field) => field.fieldKey),
    ).toEqual(keys);
    expect(
      workflowFieldCatalog
        .filter((field) => field.stepKey === "quotation" && field.defaultMode === "required")
        .map((field) => field.fieldKey),
    ).toEqual(
      quotationNativeFieldCatalog
        .filter((field) => field.defaultMode === "required")
        .map((field) => field.fieldKey),
    );
  });

  it("keeps quote defaults and module ownership aligned with the registry",() => {
    expect(quotationNativeFieldCatalog.filter((field) => field.defaultMode === "required")).toHaveLength(19);
    expect(quotationNativeFieldCatalog.filter((field) => field.defaultMode === "optional").map((field) => field.fieldKey)).toEqual([
      "quotation_mark_contacts",
      "quotation_quote_commercial_user_id",
      "quotation_exit_port",
      "quotation_transit_locations",
      "quotation_customs_location",
      "quotation_domestic_agent",
      ...intakeOperationFields.map(field=>intakeOperationFieldKey(field.key)),
      "quotation_destination_warehouse_note",
      "quotation_notes",
      "quotation_valid_until",
    ]);
    expect(new Set(quotationNativeFieldCatalog.map((field) => field.moduleCode))).toEqual(
      new Set(["consignment","cargo","costs"]),
    );
  });

  it("resolves composite, numeric and charge presence from native quote storage",() => {
    const quote = {
      origin_country:"中国",origin_state:"广东省",origin_city:"深圳市",
      destination_country:"乌兹别克斯坦",destination_state:"塔什干州",destination_city:"塔什干",
      pieces:2,gross_weight_kg:300,quotation_charge_items:1,
    };
    expect(quotationNativeFieldPresent("quotation_origin_region",quote)).toBe(true);
    expect(quotationNativeFieldPresent("quotation_destination_region",quote)).toBe(true);
    expect(quotationNativeFieldPresent("quotation_pieces",quote)).toBe(true);
    expect(quotationNativeFieldPresent("quotation_charge_items",quote)).toBe(true);
    expect(quotationNativeFieldPresent("quotation_pickup_address",quote)).toBe(false);
  });

  it("honors required, optional and hidden modes and excludes native fields from generic storage",() => {
    const fields = [
      field("native","quotation_cargo_description",1,1),
      field("hidden","quotation_notes",1,0),
      field("custom","quote_trade_term",1,1),
    ];
    expect(quotationWorkflowFieldPolicy(fields,"quotation_cargo_description","optional")).toEqual({
      isActive:true,isRequired:true,
    });
    expect(quotationWorkflowFieldPolicy(fields,"quotation_notes","required")).toEqual({
      isActive:false,isRequired:false,
    });
    expect(activeQuotationCustomWorkflowFields(fields).map((item) => item.field_key)).toEqual([
      "quote_trade_term",
    ]);
  });
});

function field(id:string,fieldKey:string,isRequired:number,isActive:number):QuotationWorkflowField {
  return {
    id,workflow_id:"workflow",module_code:"consignment",field_key:fieldKey,
    label:fieldKey,field_type:"text",is_required:isRequired,is_active:isActive,
    sort_order:10,options_text:null,help_text:null,
  };
}
