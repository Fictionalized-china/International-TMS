import { describe, expect, it } from "vitest";
import { customsDeclarationGate } from "./customs-declarations";

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
