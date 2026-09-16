import { describe, expect, it } from "vitest";

import {
  canPositionHandleWorkflowField,
  canWriteWorkflowFieldAtCurrentNode,
  normalizeWorkflowFieldHandlerPositionCodes,
  toggleWorkflowFieldHandlerPosition,
} from "./workflow-field-position-access";

describe("workflow field handler positions", () => {
  it("normalizes a stable, duplicate-free position list", () => {
    expect(normalizeWorkflowFieldHandlerPositionCodes([
      " SALES ",
      "DOC",
      "SALES",
      "",
    ])).toEqual(["DOC", "SALES"]);
  });

  it("allows only a configured position and never grants account-level access", () => {
    expect(canPositionHandleWorkflowField("DOC,SALES", "SALES")).toBe(true);
    expect(canPositionHandleWorkflowField("DOC,SALES", "OPERATION")).toBe(false);
    expect(canPositionHandleWorkflowField("", "BOSS")).toBe(false);
  });

  it("adds or removes one position without changing the other positions", () => {
    expect(toggleWorkflowFieldHandlerPosition("DOC,SALES", "OPERATION", true))
      .toBe("DOC,OPERATION,SALES");
    expect(toggleWorkflowFieldHandlerPosition("DOC,SALES", "DOC", false))
      .toBe("SALES");
  });

  it("allows a configured field handler without granting the surrounding module", () => {
    expect(canWriteWorkflowFieldAtCurrentNode({
      configuredPositionCodes: ["DOC", "OPERATION"],
      positionCode: "DOC",
      canOperateCurrentNode: true,
      canOperateModule: false,
    })).toBe(true);
    expect(canWriteWorkflowFieldAtCurrentNode({
      configuredPositionCodes: ["DOC", "OPERATION"],
      positionCode: "SALES",
      canOperateCurrentNode: true,
      canOperateModule: true,
    })).toBe(false);
    expect(canWriteWorkflowFieldAtCurrentNode({
      configuredPositionCodes: ["DOC", "OPERATION"],
      positionCode: "DOC",
      canOperateCurrentNode: false,
      canOperateModule: false,
    })).toBe(false);
  });
});
