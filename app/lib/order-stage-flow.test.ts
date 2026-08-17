import { describe, expect, it } from "vitest";
import {
  orderBusinessStages,
  orderModuleAccess,
  orderModuleSequence,
  orderModuleWorkflowStageAccess,
} from "./order-stage-flow";

const workflowSteps = orderBusinessStages.map((stage, index) => ({
  stepKey: stage.code,
  stepName: stage.shortTitle,
  sortOrder: (index + 1) * 10,
}));

describe("order stage access", () => {
  it("keeps stage one editable before approval and freezes submitted data", () => {
    expect(orderModuleAccess("draft", "consignment").canEdit).toBe(true);
    expect(orderModuleAccess("draft", "costs").canEdit).toBe(true);
    expect(orderModuleAccess("submitted", "cargo").canEdit).toBe(false);
    expect(orderModuleAccess("submitted", "assignment").canEdit).toBe(true);
  });

  it("opens preparation after approval and execution after dispatch", () => {
    expect(orderModuleAccess("confirmed", "transport").canEdit).toBe(true);
    expect(orderModuleAccess("confirmed", "warehouse").canEdit).toBe(true);
    expect(orderModuleAccess("confirmed", "documents").canEdit).toBe(false);
    expect(orderModuleAccess("in_execution", "transport").canEdit).toBe(true);
    expect(orderModuleAccess("in_execution", "documents").canEdit).toBe(true);
    expect(orderModuleAccess("in_execution", "customs").canEdit).toBe(true);
    expect(orderModuleAccess("in_execution", "costs").canEdit).toBe(true);
  });

  it("keeps terminal orders viewable but read-only", () => {
    expect(orderModuleAccess("completed", "costs")).toMatchObject({
      canView: true,
      canEdit: false,
    });
    expect(orderModuleAccess("cancelled", "consignment").canEdit).toBe(false);
  });

  it("defines one unambiguous top-to-bottom business sequence", () => {
    expect(orderBusinessStages.map((stage) => stage.code)).toEqual([
      "order_creation",
      "review_assignment",
      "domestic_execution",
      "port_loading",
      "outbound_transport",
      "overseas_pickup",
      "reconciliation",
      "completion_review",
    ]);
    expect(orderModuleSequence("transport")).toBeLessThan(
      orderModuleSequence("warehouse"),
    );
    expect(orderModuleSequence("warehouse")).toBeLessThan(
      orderModuleSequence("loading"),
    );
    expect(orderModuleSequence("loading")).toBeLessThan(
      orderModuleSequence("documents"),
    );
    expect(orderModuleSequence("documents")).toBeLessThan(orderModuleSequence("customs"));
    expect(orderModuleSequence("transport")).toBeLessThan(
      orderModuleSequence("tracking"),
    );
    expect(orderModuleSequence("tracking")).toBeLessThan(
      orderModuleSequence("costs"),
    );
  });

  it("hides future module forms until their workflow stage is reached", () => {
    expect(
      orderModuleWorkflowStageAccess(
        "tracking",
        "domestic_execution",
        workflowSteps,
      ).available,
    ).toBe(false);
    expect(
      orderModuleWorkflowStageAccess(
        "documents",
        "port_loading",
        workflowSteps,
      ).available,
    ).toBe(true);
    expect(
      orderModuleWorkflowStageAccess(
        "overseas_warehouse",
        "outbound_transport",
        workflowSteps,
      ).reason,
    ).toContain("境外仓自提");
  });
});
