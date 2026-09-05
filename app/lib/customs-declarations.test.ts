import { describe, expect, it } from "vitest";
import {
  customsDeclarationGate,
  customsDeclarationNumericErrors,
} from "./customs-declarations";

describe("customsDeclarationGate", () => {
  it("requires every active declaration in the stage to be released", () => {
    const gate = customsDeclarationGate([
      { clearance_stage: "origin", status: "released", is_deleted: 0 },
      { clearance_stage: "origin", status: "declared", is_deleted: 0 },
      { clearance_stage: "destination", status: "declared", is_deleted: 0 },
    ]);
    expect(gate).toEqual({ total: 2, released: 1, pending: 1, ready: false });
  });

  it("excludes deleted and cancelled declarations", () => {
    const gate = customsDeclarationGate([
      { clearance_stage: "origin", status: "released", is_deleted: 0 },
      { clearance_stage: "origin", status: "cancelled", is_deleted: 1 },
    ]);
    expect(gate).toEqual({ total: 1, released: 1, pending: 0, ready: true });
  });

  it("does not pass without an active declaration", () => {
    const gate = customsDeclarationGate([
      { clearance_stage: "origin", status: "cancelled", is_deleted: 1 },
    ]);
    expect(gate.ready).toBe(false);
  });
});

describe("customsDeclarationNumericErrors", () => {
  it("rejects zero values when the workflow marks them required", () => {
    expect(customsDeclarationNumericErrors({
      declaredAmount: 0,
      grossWeightKg: 0,
      declaredAmountRequired: true,
      grossWeightRequired: true,
    })).toEqual(["申报金额必须大于 0", "申报毛重必须大于 0"]);
  });

  it("allows zero values only when the corresponding fields are optional", () => {
    expect(customsDeclarationNumericErrors({
      declaredAmount: 0,
      grossWeightKg: 0,
      declaredAmountRequired: false,
      grossWeightRequired: false,
    })).toEqual([]);
  });

  it("always rejects negative and non-finite values", () => {
    expect(customsDeclarationNumericErrors({
      declaredAmount: Number.NaN,
      grossWeightKg: -1,
      declaredAmountRequired: false,
      grossWeightRequired: false,
    })).toEqual([
      "申报金额必须是有效的非负数字",
      "申报毛重必须是有效的非负数字",
    ]);
  });
});
