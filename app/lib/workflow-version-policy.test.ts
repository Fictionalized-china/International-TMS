import { describe, expect, it } from "vitest";
import {
  workflowStepStatusAfterVersionSwitch,
  workflowVersionSwitchDecision,
} from "./workflow-version-policy";

describe("workflow version switch policy", () => {
  it("blocks completed and actually exited orders", () => {
    expect(workflowVersionSwitchDecision({
      affectedOrderCount: 3,
      completedOrderCount: 0,
      hasActualExit: true,
    }).allowed).toBe(false);
    expect(workflowVersionSwitchDecision({
      affectedOrderCount: 3,
      completedOrderCount: 1,
      hasActualExit: false,
    }).allowed).toBe(false);
  });

  it("allows a compatible pre-exit order or batch", () => {
    expect(workflowVersionSwitchDecision({
      affectedOrderCount: 18,
      completedOrderCount: 0,
      hasActualExit: false,
    })).toEqual({ allowed: true, reason: null });
  });

  it("never reopens historical steps when a version changes", () => {
    expect(workflowStepStatusAfterVersionSwitch({
      targetStepKey: "order_creation",
      targetSortOrder: 10,
      currentStepKey: "port_loading",
      currentSortOrder: 60,
      previousStatus: "completed",
      instanceCompleted: false,
    })).toBe("completed");
    expect(workflowStepStatusAfterVersionSwitch({
      targetStepKey: "warehouse_receiving",
      targetSortOrder: 50,
      currentStepKey: "port_loading",
      currentSortOrder: 60,
      previousStatus: null,
      instanceCompleted: false,
    })).toBe("completed");
    expect(workflowStepStatusAfterVersionSwitch({
      targetStepKey: "port_loading",
      targetSortOrder: 60,
      currentStepKey: "port_loading",
      currentSortOrder: 60,
      previousStatus: "active",
      instanceCompleted: false,
    })).toBe("active");
    expect(workflowStepStatusAfterVersionSwitch({
      targetStepKey: "outbound_transport",
      targetSortOrder: 70,
      currentStepKey: "port_loading",
      currentSortOrder: 60,
      previousStatus: null,
      instanceCompleted: false,
    })).toBe("pending");
  });
});
