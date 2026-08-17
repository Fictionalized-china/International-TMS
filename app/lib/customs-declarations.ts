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
