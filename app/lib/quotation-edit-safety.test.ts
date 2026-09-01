import { describe,expect,it } from "vitest";
import {
  changedQuotationNativeFieldKeys,
  parseQuotationChargeUpdate,
  quotationDetailFacts,
  type ExistingQuotationCharge,
} from "./quotation-edit-safety";

const existingCharges: ExistingQuotationCharge[] = [
  { id:"charge-1",description:"国际汽运费",quantity:1,unit_price:100,notes:null,sort_order:10 },
  { id:"charge-2",description:"报关费",quantity:2,unit_price:25,notes:"原备注",sort_order:20 },
];

describe("quotation charge edit safety",() => {
  it("rejects duplicate submitted existing charge IDs",() => {
    expect(() => parseQuotationChargeUpdate({
      existing:existingCharges,
      ids:["charge-1","charge-1"],
      names:["国际汽运费","报关费"],
      quantities:[1,2],
      unitPrices:[100,25],
      notes:["","原备注"],
      required:true,
    })).toThrow("费用明细包含重复行");
  });

  it("rejects a charge ID that does not belong to this quotation",() => {
    expect(() => parseQuotationChargeUpdate({
      existing:existingCharges,
      ids:["charge-1","other-quotation-charge"],
      names:["国际汽运费","报关费"],
      quantities:[1,2],
      unitPrices:[100,25],
      notes:["","原备注"],
      required:true,
    })).toThrow("不属于当前报价");
  });

  it("rejects omission of any existing row so total and details cannot diverge",() => {
    expect(() => parseQuotationChargeUpdate({
      existing:existingCharges,
      ids:["charge-1"],
      names:["国际汽运费"],
      quantities:[1],
      unitPrices:[100],
      notes:[""],
      required:true,
    })).toThrow("遗漏了 1 条已有费用");
  });

  it("accepts exact coverage, detects edits, and preserves a valid new row",() => {
    const unchanged = parseQuotationChargeUpdate({
      existing:existingCharges,
      ids:["charge-1","charge-2"],
      names:["国际汽运费","报关费"],
      quantities:[1,2],
      unitPrices:[100,25],
      notes:["","原备注"],
      required:true,
    });
    expect(unchanged.changed).toBe(false);

    const changed = parseQuotationChargeUpdate({
      existing:existingCharges,
      ids:["charge-1","charge-2",""],
      names:["国际汽运费","报关费","仓储费"],
      quantities:[1,2,1],
      unitPrices:[100,30,80],
      notes:["","新备注",""],
      required:true,
    });
    expect(changed.changed).toBe(true);
    expect(changed.charges).toHaveLength(3);
    expect(changed.charges[2]).toMatchObject({ id:"",name:"仓储费",amount:80 });
  });

  it("ignores the single empty starter row when charges are optional",() => {
    expect(parseQuotationChargeUpdate({
      existing:[],ids:[""],names:["国际汽运费"],quantities:[1],unitPrices:[0],notes:[""],required:false,
    })).toEqual({ charges:[],changed:false });
  });
});

describe("quotation edit audit diff",() => {
  it("reports changed native policy keys and treats null, empty and surrounding whitespace equally",() => {
    const before = {
      origin_country:"CN",origin_state:"44",origin_city:"4403",
      cargo_description:" 电子产品 ",notes:null,estimated_width_cm:30,
    };
    const after = {
      ...before,
      origin_city:"4401",
      cargo_description:"电子产品",
      notes:"",
      estimated_width_cm:35,
    };
    expect(changedQuotationNativeFieldKeys(before,after)).toEqual([
      "quotation_origin_region",
      "quotation_width_cm",
    ]);
  });
});

describe("quotation detail field visibility",() => {
  it("does not leak hidden route, piece/weight/volume, or dimension siblings through composite text",() => {
    const facts = quotationDetailFacts({
      origin_country:"ORIGIN-COUNTRY",origin_state:"ORIGIN-STATE",origin_city:"ORIGIN-CITY",
      destination_country:"DEST-SECRET",destination_state:"DEST-STATE-SECRET",destination_city:"DEST-CITY-SECRET",
      pieces:111,gross_weight_kg:222,volume_cbm:333,
      estimated_length_cm:444,estimated_width_cm:555,estimated_height_cm:666,
    },(key) => new Set([
      "quotation_origin_region",
      "quotation_gross_weight_kg",
      "quotation_length_cm",
    ]).has(key));

    expect(facts.map((fact) => fact.key)).toEqual([
      "quotation_origin_region",
      "quotation_gross_weight_kg",
      "quotation_length_cm",
    ]);
    const rendered = facts.map((fact) => fact.value).join(" | ");
    expect(rendered).toContain("ORIGIN-COUNTRY ORIGIN-STATE ORIGIN-CITY");
    expect(rendered).toContain("222 KG");
    expect(rendered).toContain("444 CM");
    expect(rendered).not.toMatch(/DEST-SECRET|111|333|555|666/);
  });
});
