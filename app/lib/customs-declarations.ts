export type CustomsDeclarationGateRow = {
  clearance_stage: string;
  status: string;
  is_deleted: number;
};

export type CustomsDeclarationGate = {
  total: number;
  released: number;
  pending: number;
  ready: boolean;
};

export type CustomsDeclarationNextAction = "create" | "release" | "complete";

export function customsDeclarationNextAction(
  rows: Pick<CustomsDeclarationGateRow, "status" | "is_deleted">[],
): CustomsDeclarationNextAction {
  const active = rows.filter(
    (row) => row.is_deleted !== 1 && row.status !== "cancelled",
  );
  if (active.length === 0) return "create";
  return active.some((row) => row.status !== "released")
    ? "release"
    : "complete";
}

export function customsDeclarationGate(
  rows: CustomsDeclarationGateRow[],
  clearanceStage = "origin",
): CustomsDeclarationGate {
  const active = rows.filter(
    (row) =>
      row.clearance_stage === clearanceStage &&
      row.is_deleted !== 1 &&
      row.status !== "cancelled",
  );
  const released = active.filter((row) => row.status === "released").length;
  return {
    total: active.length,
    released,
    pending: active.length - released,
    ready: active.length > 0 && released === active.length,
  };
}
