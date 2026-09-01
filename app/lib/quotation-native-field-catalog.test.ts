import { describe,expect,it } from "vitest";
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
  it("derives every quote workflow surface from one unique 19-field registry",() => {
    const keys = quotationNativeFieldCatalog.map((field) => field.fieldKey);
    expect(keys).toHaveLength(19);
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
    expect(quotationNativeFieldCatalog.filter((field) => field.defaultMode === "required")).toHaveLength(16);
    expect(quotationNativeFieldCatalog.filter((field) => field.defaultMode === "optional").map((field) => field.fieldKey)).toEqual([
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
