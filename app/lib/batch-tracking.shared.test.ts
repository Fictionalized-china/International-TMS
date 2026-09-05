import { describe, expect, it } from "vitest";
import {
  isActualExitTrackingMilestone,
  missingBatchTrackingPrerequisites,
  resolveTrackingWorkflowHandoff,
} from "./batch-tracking.shared";

describe("batch tracking workflow field aliases", () => {
  it("treats the canonical exported milestone as actual exit evidence", () => {
    expect(isActualExitTrackingMilestone("exported")).toBe(true);
    expect(isActualExitTrackingMilestone("exit")).toBe(true);
    expect(isActualExitTrackingMilestone("actual_exit")).toBe(true);
    expect(isActualExitTrackingMilestone("border_arrived")).toBe(false);
  });
});

describe("batch tracking sequence policy", () => {
  it("requires port arrival before actual exit", () => {
    expect(missingBatchTrackingPrerequisites([], "exported")).toEqual([
      "border_arrived",
    ]);
    expect(
      missingBatchTrackingPrerequisites(["border_arrived"], "exported"),
    ).toEqual([]);
  });

  it("does not treat the later exit node as proof of port arrival", () => {
    expect(
      missingBatchTrackingPrerequisites(["exported"], "exported"),
    ).toEqual(["border_arrived"]);
  });
});

describe("tracking to overseas warehouse handoff", () => {
  const standardFields = [
    { fieldKey: "actual_exit_at", isActive: true, isRequired: true },
    { fieldKey: "tracking_milestone", isActive: true, isRequired: true },
  ];

  it.each(["ftl", "ltl"])(
    "hands %s orders to the overseas warehouse after the last required in-transit node",
    () => {
      const waiting = resolveTrackingWorkflowHandoff({
        fields: standardFields,
        recordedCodes: ["border_arrived", "exported", "foreign_entered"],
      });
      expect(waiting).toMatchObject({
        boundaryCode: "customs_cleared",
        ready: false,
        missingCodes: ["customs_cleared"],
        warehouseOwnedCode: "station_arrived",
      });

      const ready = resolveTrackingWorkflowHandoff({
        fields: standardFields,
        recordedCodes: [
          "border_arrived",
          "exported",
          "foreign_entered",
          "customs_cleared",
        ],
      });
      expect(ready.ready).toBe(true);
      expect(ready.requiredCodes).not.toContain("station_arrived");
    },
  );

  it("uses actual exit as the fail-closed boundary when milestone collection is not required", () => {
    const fields = [
      { fieldKey: "actual_exit_at", isActive: true, isRequired: true },
      { fieldKey: "tracking_milestone", isActive: true, isRequired: false },
    ];
    expect(resolveTrackingWorkflowHandoff({ fields, recordedCodes: [] })).toMatchObject({
      boundaryCode: "exported",
      ready: false,
      missingCodes: ["exported"],
    });
    expect(resolveTrackingWorkflowHandoff({ fields, recordedCodes: ["exported"] })).toMatchObject({
      boundaryCode: "exported",
      ready: true,
      missingCodes: [],
    });
  });

  it("does not invent a warehouse arrival when evaluating tracking completion", () => {
    const result = resolveTrackingWorkflowHandoff({
      fields: standardFields,
      recordedCodes: [
        "border_arrived",
        "exported",
        "foreign_entered",
        "customs_cleared",
      ],
    });
    expect(result.requiredCodes).toEqual([
      "border_arrived",
      "exported",
      "foreign_entered",
      "customs_cleared",
    ]);
    expect(result.warehouseOwnedCode).toBe("station_arrived");
  });
});
