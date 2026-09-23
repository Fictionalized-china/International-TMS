export type TrackingCenterSource = {
  orderStatus: string;
  isOverdue: boolean;
  exceptionStatus: string;
  assignmentId: string | null;
  batchId: string | null;
  batchRoadStatus: string | null;
  plannedArrivalAt: string | null;
  actualArrivalAt: string | null;
  latestEventAt: string | null;
};

export type TrackingCenterDerivedState = {
  dispatch: {
    code: "pending_dispatch" | "scheduled" | "in_transit" | "completed";
    label: string;
  };
  warning: {
    code: "normal" | "upcoming" | "overdue" | "stale" | "exception";
    label: string;
    tone: "success" | "warning" | "danger";
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveTrackingCenterState(
  source: TrackingCenterSource,
  now = new Date(),
): TrackingCenterDerivedState {
  const completed = source.orderStatus === "completed" ||
    source.batchRoadStatus === "pickup_completed" || Boolean(source.actualArrivalAt);
  const inTransit = [
    "outbound_in_transit",
    "overseas_arrived",
    "waiting_pickup",
  ].includes(source.batchRoadStatus ?? "");
  const dispatch = completed
    ? { code: "completed" as const, label: "运输已完成" }
    : inTransit
      ? { code: "in_transit" as const, label: "运输执行中" }
      : source.assignmentId || source.batchId
        ? { code: "scheduled" as const, label: "已调度待发运" }
        : { code: "pending_dispatch" as const, label: "待调度" };

  if (completed) {
    return { dispatch, warning: { code: "normal", label: "时效正常", tone: "success" } };
  }
  if (["warning", "exception"].includes(source.exceptionStatus)) {
    return { dispatch, warning: { code: "exception", label: "运输异常", tone: "danger" } };
  }

  const nowAt = now.getTime();
  const plannedArrivalAt = timestamp(source.plannedArrivalAt);
  if (source.isOverdue || (plannedArrivalAt !== null && plannedArrivalAt < nowAt)) {
    return { dispatch, warning: { code: "overdue", label: "已超时", tone: "danger" } };
  }
  const latestEventAt = timestamp(source.latestEventAt);
  if (latestEventAt !== null && nowAt - latestEventAt > 2 * DAY_MS && ["scheduled", "in_transit"].includes(dispatch.code)) {
    return { dispatch, warning: { code: "stale", label: "超过48小时未更新", tone: "warning" } };
  }
  if (plannedArrivalAt !== null && plannedArrivalAt - nowAt <= DAY_MS) {
    return { dispatch, warning: { code: "upcoming", label: "24小时内到期", tone: "warning" } };
  }
  return { dispatch, warning: { code: "normal", label: "时效正常", tone: "success" } };
}

export function summarizeTrackingCenter(
  rows: ReadonlyArray<{ orderId: string } & TrackingCenterDerivedState>,
) {
  const unique = [...new Map(rows.map((row) => [row.orderId, row])).values()];
  return {
    total: unique.length,
    pendingDispatch: unique.filter((row) => row.dispatch.code === "pending_dispatch").length,
    inTransit: unique.filter((row) => row.dispatch.code === "in_transit").length,
    warnings: unique.filter((row) => ["overdue", "stale", "exception"].includes(row.warning.code)).length,
    completed: unique.filter((row) => row.dispatch.code === "completed").length,
  };
}
