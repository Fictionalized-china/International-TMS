import { describe, expect, it } from "vitest";
import {
  customsDeclarationGate,
  customsDeclarationNextAction,
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

describe("customsDeclarationNextAction", () => {
  it("offers declaration creation when no active declaration exists", () => {
    expect(customsDeclarationNextAction([])).toBe("create");
    expect(
      customsDeclarationNextAction([
        { status: "cancelled", is_deleted: 1 },
      ]),
    ).toBe("create");
  });

  it("offers release when any active declaration is still pending", () => {
    expect(
      customsDeclarationNextAction([
        { status: "released", is_deleted: 0 },
        { status: "declared", is_deleted: 0 },
      ]),
    ).toBe("release");
  });

  it("hides pending actions after every active declaration is released", () => {
    expect(
      customsDeclarationNextAction([
        { status: "released", is_deleted: 0 },
      ]),
    ).toBe("complete");
  });
});
