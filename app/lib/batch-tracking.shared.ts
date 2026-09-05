import {
  runtimeWorkflowFieldPolicy,
  type RuntimeWorkflowFieldLike,
} from "./workflow-field-runtime";

export type BatchTrackingMilestone = {
  code: string;
  name: string;
  progress: number;
  optional?: boolean;
};

export const BATCH_TRACKING_MILESTONES: BatchTrackingMilestone[] = [
  { code: "border_arrived", name: "口岸到达", progress: 28 },
  { code: "exported", name: "出境", progress: 40 },
  { code: "transloaded", name: "换装", progress: 46, optional: true },
  { code: "transit_customs", name: "转关", progress: 52, optional: true },
  { code: "foreign_entered", name: "海外入境", progress: 64 },
  { code: "customs_cleared", name: "目的清关", progress: 82 },
  { code: "station_arrived", name: "目的仓到达", progress: 100 },
];

export const BATCH_TRACKING_MAIN_CODES = [
  "border_arrived",
  "exported",
  "foreign_entered",
  "customs_cleared",
  "station_arrived",
];

export const BATCH_TRACKING_OPTIONAL_CODES = ["transloaded", "transit_customs"];

export const ACTUAL_EXIT_TRACKING_MILESTONE_CODES = new Set([
  "exported",
  "exit",
  "actual_exit",
]);

export function isActualExitTrackingMilestone(code: unknown) {
  return ACTUAL_EXIT_TRACKING_MILESTONE_CODES.has(String(code ?? ""));
}

export const BATCH_TRACKING_REQUIRED_PREVIOUS: Record<string, string[]> = {
  exported: ["border_arrived"],
  transloaded: ["exported"],
  transit_customs: ["exported"],
  foreign_entered: ["exported"],
  customs_cleared: ["foreign_entered"],
  station_arrived: ["customs_cleared"],
};

export function missingBatchTrackingPrerequisites(
  completedCodes: Iterable<string>,
  milestoneCode: string,
): string[] {
  const completed = new Set(completedCodes);
  return (BATCH_TRACKING_REQUIRED_PREVIOUS[milestoneCode] ?? []).filter(
    (code) => !completed.has(code),
  );
}

export const TRACKING_HANDOFF_MILESTONE_CODE = "customs_cleared";
export const TRACKING_WAREHOUSE_OWNED_MILESTONE_CODE = "station_arrived";
export const TRACKING_REQUIRED_IN_TRANSIT_MILESTONE_CODES = [
  "border_arrived",
  "exported",
  "foreign_entered",
  TRACKING_HANDOFF_MILESTONE_CODE,
] as const;

/**
 * Resolve the tracking module's completion boundary from the frozen field
 * policy. Destination-warehouse arrival is deliberately excluded: it is the
 * first physical event owned by the next workflow module and must be produced
 * by the overseas warehouse scan, never used to unlock that scan.
 *
 * A required milestone field makes every main in-transit node through
 * destination customs clearance a gate. If the workflow makes milestone
 * collection optional, actual exit remains the fail-closed physical handoff
 * proof; this prevents a required tracking module with a malformed/empty
 * field snapshot from silently completing without an exit event.
 */
export function resolveTrackingWorkflowHandoff(input: {
  fields: readonly RuntimeWorkflowFieldLike[];
  recordedCodes: Iterable<string>;
}) {
  const milestonePolicy = runtimeWorkflowFieldPolicy(
    input.fields,
    "tracking_milestone",
    true,
  );
  const requiredCodes = milestonePolicy.required
    ? [...TRACKING_REQUIRED_IN_TRANSIT_MILESTONE_CODES]
    : ["exported"];
  const recorded = new Set(input.recordedCodes);
  const missingCodes = requiredCodes.filter((code) => !recorded.has(code));
  return {
    boundaryCode: milestonePolicy.required
      ? TRACKING_HANDOFF_MILESTONE_CODE
      : "exported",
    requiredCodes,
    missingCodes,
    ready: missingCodes.length === 0,
    warehouseOwnedCode: TRACKING_WAREHOUSE_OWNED_MILESTONE_CODE,
  };
}
