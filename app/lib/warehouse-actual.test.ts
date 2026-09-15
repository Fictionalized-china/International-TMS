import { describe, expect, it } from "vitest";
import { calculateWarehouseDifference } from "./warehouse-actual";

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
