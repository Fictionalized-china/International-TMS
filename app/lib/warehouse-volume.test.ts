import { describe, expect, it } from "vitest";
import {
  calculateWarehouseVolumeCbm,
  formatWarehouseVolumeCbm,
} from "./warehouse-volume";

describe("warehouse volume calculation", () => {
  it("calculates small overseas-package volumes without truncating to zero", () => {
    const volume = calculateWarehouseVolumeCbm({
      lengthCm: 15,
      widthCm: 10,
      heightCm: 6,
    });

    expect(volume).toBe(0.0009);
    expect(formatWarehouseVolumeCbm(volume)).toBe("0.0009");
  });

  it("calculates the total volume for a domestic receipt row", () => {
    expect(
      calculateWarehouseVolumeCbm({
        lengthCm: 100,
        widthCm: 50,
        heightCm: 40,
        packageCount: 3,
      }),
    ).toBe(0.6);
  });

  it("does not produce a volume until every positive measurement is present", () => {
    expect(
      calculateWarehouseVolumeCbm({
        lengthCm: 15,
        widthCm: 0,
        heightCm: 6,
      }),
    ).toBeNull();
  });

  it("keeps a zero-package domestic row valid without adding volume", () => {
    expect(
      calculateWarehouseVolumeCbm({
        lengthCm: 100,
        widthCm: 50,
        heightCm: 40,
        packageCount: 0,
      }),
    ).toBe(0);
  });
});
