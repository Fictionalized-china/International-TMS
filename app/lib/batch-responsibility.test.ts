import { describe, expect, it } from "vitest";
import {
  batchRequiresSupervisorApproval,
  batchSharedResponsibilityIsActive,
  canOrdinaryReassignBatchResponsibility,
} from "./batch-responsibility";

describe("batch responsibility policy", () => {
  it("applies supervisor approval only to consolidated PZ batches", () => {
    expect(batchRequiresSupervisorApproval("PZ-20260905-001")).toBe(true);
    expect(batchRequiresSupervisorApproval("FTL-20260905-001")).toBe(false);
  });

  it("allows ordinary reassignment only before actual exit", () => {
    expect(canOrdinaryReassignBatchResponsibility({
      batchNumber: "PZ-20260905-001",
      approvalStatus: "approved",
      roadStatus: "loaded_waiting_exit",
      actualDepartureAt: null,
    })).toBe(true);
    expect(canOrdinaryReassignBatchResponsibility({
      batchNumber: "PZ-20260905-001",
      approvalStatus: "approved",
      roadStatus: "outbound_in_transit",
      actualDepartureAt: "2026-09-05T03:00:00.000Z",
    })).toBe(false);
  });

  it("ends shared PZ operation and document responsibility at overseas arrival", () => {
    expect(batchSharedResponsibilityIsActive("outbound_in_transit")).toBe(true);
    expect(batchSharedResponsibilityIsActive("overseas_arrived")).toBe(false);
    expect(batchSharedResponsibilityIsActive("waiting_pickup")).toBe(false);
  });
});
