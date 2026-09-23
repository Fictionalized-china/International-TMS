import { describe, expect, it } from "vitest";
import {
  deriveTrackingCenterState,
  summarizeTrackingCenter,
  type TrackingCenterSource,
} from "./tracking-center";

const base: TrackingCenterSource = {
  orderStatus: "in_execution",
  isOverdue: false,
  exceptionStatus: "normal",
  assignmentId: "assignment-1",
  batchId: null,
  batchRoadStatus: null,
  plannedArrivalAt: "2026-09-25T12:00:00.000Z",
  actualArrivalAt: null,
  latestEventAt: "2026-09-23T08:00:00.000Z",
};

describe("tracking center derived state", () => {
  it("separates dispatch status from timeliness warning", () => {
    const state = deriveTrackingCenterState(base, new Date("2026-09-23T12:00:00.000Z"));
    expect(state.dispatch).toEqual({ code: "scheduled", label: "已调度待发运" });
    expect(state.warning).toEqual({ code: "normal", label: "时效正常", tone: "success" });
  });

  it("marks unassigned work as pending dispatch", () => {
    const state = deriveTrackingCenterState({ ...base, assignmentId: null }, new Date("2026-09-23T12:00:00.000Z"));
    expect(state.dispatch.code).toBe("pending_dispatch");
  });

  it("raises overdue and stale tracking warnings without blocking workflow", () => {
    expect(deriveTrackingCenterState({
      ...base,
      plannedArrivalAt: "2026-09-22T12:00:00.000Z",
    }, new Date("2026-09-23T12:00:00.000Z")).warning.code).toBe("overdue");

    expect(deriveTrackingCenterState({
      ...base,
      plannedArrivalAt: null,
      latestEventAt: "2026-09-20T12:00:00.000Z",
    }, new Date("2026-09-23T12:00:00.000Z")).warning.code).toBe("stale");

    expect(deriveTrackingCenterState({
      ...base,
      batchRoadStatus: "outbound_in_transit",
      plannedArrivalAt: null,
      latestEventAt: "2026-09-20T12:00:00.000Z",
    }, new Date("2026-09-23T12:00:00.000Z")).warning.code).toBe("stale");
  });

  it("summarizes the control tower without double-counting rows", () => {
    const rows = [
      { orderId: "o-1", ...deriveTrackingCenterState(base, new Date("2026-09-23T12:00:00.000Z")) },
      { orderId: "o-2", ...deriveTrackingCenterState({ ...base, assignmentId: null }, new Date("2026-09-23T12:00:00.000Z")) },
      { orderId: "o-3", ...deriveTrackingCenterState({ ...base, isOverdue: true }, new Date("2026-09-23T12:00:00.000Z")) },
    ];
    expect(summarizeTrackingCenter(rows)).toEqual({
      total: 3,
      pendingDispatch: 1,
      inTransit: 0,
      warnings: 1,
      completed: 0,
    });
  });
});
