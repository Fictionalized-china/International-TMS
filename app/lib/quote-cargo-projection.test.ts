import { describe, expect, it } from "vitest";
import {
  INSERT_QUOTE_CARGO_PACKAGES_SQL,
  MAX_QUOTE_AUTO_PACKAGES,
  assertQuoteAutoPackageCount,
  calculateQuoteTotalVolumeCbm,
  quoteCargoProjection,
  resolveQuoteTotalVolumeCbm,
} from "./quote-cargo-projection";

describe("quotation volume calculation", () => {
  it("calculates the quoted total from identical per-package dimensions", () => {
    expect(calculateQuoteTotalVolumeCbm({
      pieces: 2,
      lengthCm: 120,
      widthCm: 80,
      heightCm: 90,
    })).toBe(1.728);
  });

  it("does not calculate until every positive input is present", () => {
    expect(calculateQuoteTotalVolumeCbm({
      pieces: 2,
      lengthCm: 120,
      widthCm: 0,
      heightCm: 90,
    })).toBeNull();
  });

  it("overrides forged submitted volume whenever dimensions are authoritative", () => {
    expect(resolveQuoteTotalVolumeCbm({
      deriveFromDimensions: true,
      pieces: 2,
      lengthCm: 120,
      widthCm: 80,
      heightCm: 90,
      submittedVolumeCbm: 999,
    })).toBe(1.728);
    expect(resolveQuoteTotalVolumeCbm({
      deriveFromDimensions: false,
      pieces: 2,
      lengthCm: 120,
      widthCm: 80,
      heightCm: 90,
      submittedVolumeCbm: 2.5,
    })).toBe(2.5);
  });

  it("keeps the submitted total when configured dimension inputs are incomplete", () => {
    expect(resolveQuoteTotalVolumeCbm({
      deriveFromDimensions: true,
      pieces: 2,
      lengthCm: 120,
      widthCm: 0,
      heightCm: 90,
      submittedVolumeCbm: 2.5,
    })).toBe(2.5);
  });
});

describe("quote package insert SQL", () => {
  it("keeps its recursive insert binding contract explicit", () => {
    expect(INSERT_QUOTE_CARGO_PACKAGES_SQL.match(/\?/g)).toHaveLength(8);
  });
});

describe("quoteCargoProjection", () => {
  it("keeps declared product quantity separate from physical packages", () => {
    const result = quoteCargoProjection({
      pieces: 20,
      plannedPackageCount: 10,
      totalGrossWeightKg: 110,
      totalVolumeCbm: 1.728,
    });

    expect(result).toMatchObject({
      declaredQuantity: 20,
      packageCount: 10,
      piecesPerPackage: 1,
      grossWeightPerPackageKg: 11,
      netWeightPerPackageKg: 11,
      volumePerPackageCbm: 0.1728,
    });
    expect(result.packageCount * result.grossWeightPerPackageKg).toBeCloseTo(110);
    expect(result.packageCount * result.volumePerPackageCbm).toBeCloseTo(1.728);
  });

  it("keeps a one-piece quotation as one package", () => {
    expect(quoteCargoProjection({
      pieces: 1,
      plannedPackageCount: 1,
      totalGrossWeightKg: 25,
      totalVolumeCbm: 0.5,
    })).toEqual({
      declaredQuantity: 1,
      packageCount: 1,
      piecesPerPackage: 1,
      grossWeightPerPackageKg: 25,
      netWeightPerPackageKg: 25,
      volumePerPackageCbm: 0.5,
    });
  });

  it.each([0, -1, 1.5, MAX_QUOTE_AUTO_PACKAGES + 1, Number.NaN])(
    "rejects an unsupported quoted piece count %s",
    (pieces) => expect(() => assertQuoteAutoPackageCount(pieces)).toThrow(/1–500/),
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid quotation totals %s",
    (value) => expect(() => quoteCargoProjection({
      pieces: 1,
      plannedPackageCount: 1,
      totalGrossWeightKg: value,
      totalVolumeCbm: 1,
    })).toThrow(/预计重量/),
  );
});
