import { describe, expect, it } from "vitest";
import { missingOrderIntakeFees } from "./order-intake-fees";
import { defaultBusinessProcessPolicy } from "./business-process-policy";

describe("order intake expense gates", () => {
  it("requires both AR and AP without requiring zero to be positive", () => {
    const expenses = [{chargeCode:"PICKUP",chargeName:"提货费",amount:0,direction:"receivable" as const}];
    const policy = {...defaultBusinessProcessPolicy,"order.ftl_required_fees":"pickup"};
    expect(missingOrderIntakeFees("ftl",expenses,policy).map(r=>r.code)).toEqual(["payable"]);
    expect(missingOrderIntakeFees("ftl",[...expenses,{...expenses[0],direction:"payable"}],policy)).toEqual([]);
  });
  it("supports configured custom fee codes and disabled category gates", () => {
    expect(missingOrderIntakeFees("ltl",[{chargeCode:"PACKING",chargeName:"包装费",amount:10,direction:"receivable"}],{...defaultBusinessProcessPolicy,"order.ltl_required_fees":"PACKING"})).toEqual([]);
    expect(missingOrderIntakeFees("ltl",[],{...defaultBusinessProcessPolicy,"order.ltl_required_fees":"","order.require_receivable":"0"})).toEqual([]);
  });
  it("does not count transit customs as a port declaration fee", () => {
    expect(missingOrderIntakeFees("ftl",[{chargeCode:"TRANSIT_CUSTOMS",chargeName:"转关费",amount:1}]).map(r=>r.code)).toContain("customs_port");
  });
  it("requires all six agreed categories before an FTL order can be submitted", () => {
    const missing = missingOrderIntakeFees("ftl", [
      { chargeCode: "PICKUP", chargeName: "提货费", amount: 100 },
      { chargeCode: "HANDLING", chargeName: "装卸费", amount: 0 },
    ]);
    expect(missing.map((item) => item.label)).toEqual([
      "仓储费", "报关/口岸费", "境外司机费", "转关费",
    ]);
  });

  it("requires only pickup for an LTL order and accepts explicit zero", () => {
    expect(missingOrderIntakeFees("ltl", [
      { chargeCode: "PICKUP", chargeName: "客户自送提货费", amount: 0 },
    ])).toEqual([]);
  });

  it("recognizes configured free-text names without forcing a single charge code", () => {
    expect(missingOrderIntakeFees("ftl", [
      { chargeCode: "A", chargeName: "客户提货费", amount: 1 },
      { chargeCode: "B", chargeName: "装卸服务费", amount: 1 },
      { chargeCode: "C", chargeName: "临时仓储费", amount: 1 },
      { chargeCode: "D", chargeName: "口岸服务费", amount: 1 },
      { chargeCode: "E", chargeName: "境外司机费用", amount: 1 },
      { chargeCode: "F", chargeName: "转关服务费", amount: 1 },
    ])).toEqual([]);
  });
});
