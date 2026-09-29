import { describe, expect, it } from "vitest";
import {
  calculateWarehouseDifference,
  displayWarehouseMeasuredCount,
  displayWarehouseMeasuredDimensions,
  displayWarehouseMeasuredDimensionSummary,
  shouldCreateWarehouseDifference,
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

  it("does not report hidden precision tails that render as the same warehouse value", () => {
    expect(calculateWarehouseDifference(
      { pieces: 1, weightKg: 12.004, volumeCbm: 174.0004 },
      { pieces: 1, weightKg: 12, volumeCbm: 174 },
    )).toMatchObject({ hasDifference: false, requiresFeeConfirmation: false, maxPercent: 0 });
  });

  it("keeps a sub-threshold measurement difference out of the blocking exception queue", () => {
    const difference = calculateWarehouseDifference(
      { pieces: 1, weightKg: 100, volumeCbm: 1 },
      { pieces: 1, weightKg: 104, volumeCbm: 1 },
    );
    expect(difference).toMatchObject({ hasDifference: true, requiresFeeConfirmation: false });
    expect(shouldCreateWarehouseDifference({ difference })).toBe(false);
    expect(shouldCreateWarehouseDifference({ difference, packageMismatch: true })).toBe(true);
  });

  it("uses the supplied organization threshold instead of a hard-coded exception value", () => {
    expect(calculateWarehouseDifference(
      { pieces: 1, weightKg: 100, volumeCbm: 1 },
      { pieces: 1, weightKg: 103, volumeCbm: 1 },
      2,
    ).requiresFeeConfirmation).toBe(true);
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
