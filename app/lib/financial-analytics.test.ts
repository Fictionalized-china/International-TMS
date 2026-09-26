import { describe, expect, it } from "vitest";
import {
  agingBand,
  allocateByChargeableWeight,
  chargeableWeightKg,
  classifyCost,
  comparisonLabel,
  creditStatus,
  isExcludedFromGrossProfit,
  volumetricWeightKg,
} from "./financial-analytics";

describe("financial analytics business rules", () => {
  it("uses the confirmed 1:300 volumetric weight rule", () => {
    expect(volumetricWeightKg(2)).toBe(600);
    expect(chargeableWeightKg(550, 2)).toBe(600);
    expect(chargeableWeightKg(700, 2)).toBe(700);
  });

  it("allocates by chargeable weight and preserves the cent total", () => {
    const rows = allocateByChargeableWeight([
      { id: "a", actualWeightKg: 100, volumeCbm: 1 },
      { id: "b", actualWeightKg: 400, volumeCbm: 0.5 },
    ], 1000);
    expect(rows.map((row) => row.chargeableWeightKg)).toEqual([300, 400]);
    expect(rows.reduce((sum, row) => sum + row.allocatedAmount, 0)).toBe(1000);
    expect(rows[0].allocatedAmount).toBe(428.57);
    expect(rows[1].allocatedAmount).toBe(571.43);
  });

  it("keeps pass-through taxes, damages and penalties outside operating gross profit", () => {
    expect(isExcludedFromGrossProfit("CUSTOMS_TAX", "过关税费")).toBe(true);
    expect(isExcludedFromGrossProfit("DAMAGE", "货损赔偿")).toBe(true);
    expect(isExcludedFromGrossProfit("INSURANCE", "运输保险费")).toBe(false);
    expect(isExcludedFromGrossProfit("FREIGHT", "境外运费")).toBe(false);
  });

  it("maps settlement charges to the document cost categories", () => {
    expect(classifyCost("DOMESTIC_FREIGHT", "国内运输费")).toBe("国内运费");
    expect(classifyCost("PORT", "口岸服务费")).toBe("口岸服务费");
    expect(classifyCost("DAMAGE", "货损赔偿")).toBe("赔偿及罚款");
  });

  it("uses the confirmed overdue warning bands", () => {
    expect(agingBand(0)).toBe("未到期");
    expect(agingBand(15)).toBe("1-15天");
    expect(agingBand(30)).toBe("16-30天");
    expect(agingBand(60)).toBe("31-60天");
    expect(agingBand(61)).toBe("60天以上");
    expect(creditStatus(61)).toBe("坏账风险");
  });

  it("uses explicit comparison labels when the previous period is empty", () => {
    expect(comparisonLabel(100, 0)).toBe("新增");
    expect(comparisonLabel(0, 0)).toBe("—");
    expect(comparisonLabel(100, 80)).toBe("+25.0%");
    expect(comparisonLabel(0, 10)).toBe("-100.0%");
    expect(comparisonLabel(100, 0, false)).toBe("暂无可比数据");
  });
});
