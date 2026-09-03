import { describe, expect, it } from "vitest";
import {
  isActualExitTrackingMilestone,
  missingBatchTrackingPrerequisites,
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
