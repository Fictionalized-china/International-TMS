import { describe, expect, it } from "vitest";
import { isActualExitTrackingMilestone } from "./batch-tracking.shared";

describe("batch tracking workflow field aliases", () => {
  it("treats the canonical exported milestone as actual exit evidence", () => {
    expect(isActualExitTrackingMilestone("exported")).toBe(true);
    expect(isActualExitTrackingMilestone("exit")).toBe(true);
    expect(isActualExitTrackingMilestone("actual_exit")).toBe(true);
    expect(isActualExitTrackingMilestone("border_arrived")).toBe(false);
  });
});
