import { describe, expect, it } from "vitest";
import {
  editableWorkflowFieldFlags,
  editableWorkflowFieldMode,
  normalizedWorkflowSortOrders,
  parseWorkflowSortOrder,
  workflowEditCapabilities,
  workflowInsertionSortOrder,
  workflowIntentAllowedForUsage,
} from "./workflow-edit-policy";

describe("workflow edit policy", () => {
  it("allows block structure changes only before the workflow is used", () => {
    expect(workflowEditCapabilities(0)).toEqual({
      usedByOrders: false,
      structureEditable: true,
      fieldPolicyEditable: true,
    });
    expect(workflowEditCapabilities(1)).toEqual({
      usedByOrders: true,
      structureEditable: false,
      fieldPolicyEditable: true,
    });
    expect(workflowIntentAllowedForUsage("create", 0)).toBe(true);
    expect(workflowIntentAllowedForUsage("create", 1)).toBe(false);
    expect(workflowIntentAllowedForUsage("field_mode_update", 1200)).toBe(true);
    expect(workflowIntentAllowedForUsage("field_catalog_assign", 1200)).toBe(true);
  });

  it("maps required, optional and hidden without leaving hidden fields required", () => {
    expect(editableWorkflowFieldFlags("required")).toEqual({
      isRequired: 1,
      isActive: 1,
      releasesStoredValue: false,
    });
    expect(editableWorkflowFieldFlags("optional")).toEqual({
      isRequired: 0,
      isActive: 1,
      releasesStoredValue: false,
    });
    expect(editableWorkflowFieldFlags("hidden")).toEqual({
      isRequired: 0,
      isActive: 0,
      releasesStoredValue: true,
    });
    expect(editableWorkflowFieldMode("hidden")).toBe("hidden");
    expect(editableWorkflowFieldMode("HIDDEN")).toBeNull();
    expect(editableWorkflowFieldMode("0")).toBeNull();
    expect(editableWorkflowFieldMode("O")).toBeNull();
  });

  it("rejects visually similar and malformed sort values", () => {
    expect(parseWorkflowSortOrder("0")).toBeNull();
    expect(parseWorkflowSortOrder("O")).toBeNull();
    expect(parseWorkflowSortOrder("1O")).toBeNull();
    expect(parseWorkflowSortOrder("10.5")).toBeNull();
    expect(parseWorkflowSortOrder("-10")).toBeNull();
    expect(parseWorkflowSortOrder("010")).toBe(10);
    expect(parseWorkflowSortOrder("999")).toBe(999);
    expect(parseWorkflowSortOrder("1200", 9999)).toBe(1200);
    expect(parseWorkflowSortOrder("10000", 9999)).toBeNull();
    expect(parseWorkflowSortOrder("1000")).toBeNull();
  });

  it("inserts between adjacent blocks and signals when reindexing is needed", () => {
    expect(workflowInsertionSortOrder(null, null)).toBe(10);
    expect(workflowInsertionSortOrder(null, 10)).toBe(1);
    expect(workflowInsertionSortOrder(10, 20)).toBe(15);
    expect(workflowInsertionSortOrder(10, 11)).toBeNull();
    expect(workflowInsertionSortOrder(20, null)).toBe(30);
    expect(normalizedWorkflowSortOrders(5)).toEqual([10, 20, 30, 40, 50]);
  });

  it("stays deterministic under a high-volume policy transition loop", () => {
    const modes = ["required", "optional", "hidden"] as const;
    let required = 0;
    let active = 0;
    let released = 0;
    for (let index = 0; index < 100_000; index += 1) {
      const flags = editableWorkflowFieldFlags(modes[index % modes.length]);
      required += flags.isRequired;
      active += flags.isActive;
      released += Number(flags.releasesStoredValue);
    }
    expect(required).toBe(33_334);
    expect(active).toBe(66_667);
    expect(released).toBe(33_333);
  });
});
