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

export const BATCH_TRACKING_REQUIRED_PREVIOUS: Record<string, string[]> = {
  exported: ["border_arrived"],
  transloaded: ["exported"],
  transit_customs: ["exported"],
  foreign_entered: ["exported"],
  customs_cleared: ["foreign_entered"],
  station_arrived: ["customs_cleared"],
};
