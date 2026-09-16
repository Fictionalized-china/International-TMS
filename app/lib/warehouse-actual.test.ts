import { describe, expect, it } from "vitest";
import {
  calculateWarehouseDifference,
  displayWarehouseMeasuredCount,
  displayWarehouseMeasuredDimensions,
  displayWarehouseMeasuredDimensionSummary,
} from "./warehouse-actual";

describe("calculateWarehouseDifference", () => {
  it("keeps matching actuals unblocked", () => {
    expect(calculateWarehouseDifference(
      { pieces: 10, weightKg: 100, volumeCbm: 2 },
      { pieces: 10, weightKg: 100, volumeCbm: 2 },
    )).toMatchObject({ hasDifference: false, requiresFeeConfirmation: false });
  });

  it("requires fee confirmation only when the largest difference exceeds five percent", () => {
    expect(calculateWarehouseDifference(
      { pieces: 10, weightKg: 100, volumeCbm: 2 },
      { pieces: 10, weightKg: 106, volumeCbm: 2 },
    )).toMatchObject({ hasDifference: true, requiresFeeConfirmation: true, maxPercent: 6 });
  });
});

describe("warehouse actual display", () => {
  it("keeps uncounted pieces blank instead of presenting a real zero", () => {
    expect(displayWarehouseMeasuredCount(null)).toBe("—");
    expect(displayWarehouseMeasuredCount(0)).toBe("—");
    expect(displayWarehouseMeasuredCount(3)).toBe(3);
  });

  it("keeps unmeasured dimensions blank and preserves positive measurements", () => {
    expect(displayWarehouseMeasuredDimensions(0, 0, 0)).toBe("—");
    expect(displayWarehouseMeasuredDimensions(12, 12, 12)).toBe("12 × 12 × 12");
    expect(displayWarehouseMeasuredDimensionSummary("0 × 0 × 0")).toBe("—");
    expect(displayWarehouseMeasuredDimensionSummary("0 × 0 × 0,12 × 12 × 12")).toBe("12 × 12 × 12");
  });
});
