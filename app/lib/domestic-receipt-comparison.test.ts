import { describe,expect,it } from "vitest";
import { domesticReceiptComparison } from "./domestic-receipt-comparison";
import { automaticWarehouseAcceptanceResult } from "./warehouse-acceptance-policy";

const sample={plannedPackages:3,cumulativePackages:1,cumulativeWeightKg:10,cumulativePieces:0,cumulativeVolumeCbm:0,arrivedDeclaredWeightKg:10,compareWeight:true,thresholdPercent:5};
describe("normal partial domestic receipts",()=>{
  it("does not treat the remaining two packages as shortages or a 67% weight error",()=>{
    const result=domesticReceiptComparison(sample);
    expect(result.difference.maxPercent).toBe(0);
    expect(result.packageMismatch).toBe(false);
    expect(automaticWarehouseAcceptanceResult(result.acceptanceComparison)).toBe("partial");
  });
  it("compares cumulative facts on the final arrival, without checking volume",()=>{
    const result=domesticReceiptComparison({...sample,cumulativePackages:3,cumulativeWeightKg:30,arrivedDeclaredWeightKg:30,cumulativeVolumeCbm:123});
    expect(result.difference.maxPercent).toBe(0);
    expect(automaticWarehouseAcceptanceResult(result.acceptanceComparison)).toBe("ready");
  });
  it("still flags a real arrived weight deviation or excess package count",()=>{
    expect(automaticWarehouseAcceptanceResult(domesticReceiptComparison({...sample,cumulativeWeightKg:20}).acceptanceComparison)).toBe("exception");
    const result=domesticReceiptComparison({...sample,cumulativePackages:4});
    expect(result.packageMismatch).toBe(true);
    expect(automaticWarehouseAcceptanceResult(result.acceptanceComparison)).toBe("exception");
  });
});
