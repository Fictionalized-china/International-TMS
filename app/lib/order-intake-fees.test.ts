import { describe, expect, it } from "vitest";
import { missingOrderIntakeFees } from "./order-intake-fees";

describe("order intake expense gates", () => {
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
