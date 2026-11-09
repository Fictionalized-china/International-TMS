import { describe, expect, it } from "vitest";
import { missingOrderIntakeFees } from "./order-intake-fees";
import { defaultBusinessProcessPolicy } from "./business-process-policy";

describe("order intake expense gates", () => {
  it("requires both AR and AP without requiring zero to be positive", () => {
    const expenses = [{chargeCode:"PICKUP",chargeName:"提货费",amount:0,direction:"receivable" as const}];
    const policy = {...defaultBusinessProcessPolicy,"order.ftl_required_fees":"pickup"};
    expect(missingOrderIntakeFees("ftl",expenses,policy).map(r=>r.code)).toEqual(["pickup", "payable"]);
    expect(missingOrderIntakeFees("ftl",[...expenses,{...expenses[0],direction:"payable"}],policy)).toEqual([]);
  });
  it("supports configured custom fee codes and disabled category gates", () => {
    const policy = {...defaultBusinessProcessPolicy,"order.ltl_required_fees":"PACKING"};
    const receivable = {chargeCode:"PACKING",chargeName:"包装费",amount:10,direction:"receivable" as const};
    expect(missingOrderIntakeFees("ltl",[receivable],policy).map(r=>r.code)).toEqual(["PACKING"]);
    expect(missingOrderIntakeFees("ltl",[receivable,{...receivable,direction:"payable"}],policy)).toEqual([]);
    expect(missingOrderIntakeFees("ltl",[],{...defaultBusinessProcessPolicy,"order.ltl_required_fees":"","order.require_receivable":"0"})).toEqual([]);
  });
  it("does not count transit customs as a port declaration fee", () => {
    expect(missingOrderIntakeFees("ftl",[{chargeCode:"TRANSIT_CUSTOMS",chargeName:"转关费",amount:1,direction:"payable"}]).map(r=>r.code)).toContain("customs_port");
  });
  it("requires all six agreed categories before an FTL order can be submitted", () => {
    const missing = missingOrderIntakeFees("ftl", [
      { chargeCode: "PICKUP", chargeName: "提货费", amount: 100, direction: "payable" },
      { chargeCode: "HANDLING", chargeName: "装卸费", amount: 0, direction: "payable" },
    ]);
    expect(missing.map((item) => item.label)).toEqual([
      "仓储费", "报关/口岸费", "境外司机费", "转关费",
    ]);
  });

  it("requires only pickup for an LTL order and accepts explicit zero", () => {
    expect(missingOrderIntakeFees("ltl", [
      { chargeCode: "PICKUP", chargeName: "客户自送提货费", amount: 0, direction: "payable" },
    ])).toEqual([]);
  });

  it("does not let one unrelated payable fill an FTL category present only as a receivable", () => {
    const expenses = ["pickup","handling","storage","customs_port","overseas_driver","transit_customs"]
      .map(code => ({chargeCode:code,chargeName:code,amount:1,direction:"payable" as "payable"|"receivable"}));
    expenses[1].direction = "receivable";
    expect(missingOrderIntakeFees("ftl",expenses,defaultBusinessProcessPolicy).map(row=>row.code)).toEqual(["handling"]);
  });

  it("fails closed for unspecified direction and invalid amounts", () => {
    for (const expense of [
      {chargeCode:"pickup",chargeName:"提货费",amount:0},
      {chargeCode:"pickup",chargeName:"提货费",amount:NaN,direction:"payable" as const},
      {chargeCode:"pickup",chargeName:"提货费",amount:-1,direction:"payable" as const},
    ]) expect(missingOrderIntakeFees("ltl",[expense]).map(row=>row.code)).toEqual(["pickup"]);
  });

  it("recognizes configured free-text names without forcing a single charge code", () => {
    expect(missingOrderIntakeFees("ftl", [
      { chargeCode: "A", chargeName: "客户提货费", amount: 1 },
      { chargeCode: "B", chargeName: "装卸服务费", amount: 1 },
      { chargeCode: "C", chargeName: "临时仓储费", amount: 1 },
      { chargeCode: "D", chargeName: "口岸服务费", amount: 1 },
      { chargeCode: "E", chargeName: "境外司机费用", amount: 1 },
      { chargeCode: "F", chargeName: "转关服务费", amount: 1 },
    ].map(row => ({...row, direction:"payable" as const})))).toEqual([]);
  });
});
