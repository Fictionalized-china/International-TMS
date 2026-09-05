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

export type CustomsDeclarationNumericValidationInput = {
  declaredAmount: number;
  grossWeightKg: number;
  declaredAmountRequired: boolean;
  grossWeightRequired: boolean;
};

export function customsDeclarationNumericErrors(
  input: CustomsDeclarationNumericValidationInput,
) {
  const errors: string[] = [];
  if (!Number.isFinite(input.declaredAmount) || input.declaredAmount < 0)
    errors.push("申报金额必须是有效的非负数字");
  else if (input.declaredAmountRequired && input.declaredAmount <= 0)
    errors.push("申报金额必须大于 0");

  if (!Number.isFinite(input.grossWeightKg) || input.grossWeightKg < 0)
    errors.push("申报毛重必须是有效的非负数字");
  else if (input.grossWeightRequired && input.grossWeightKg <= 0)
    errors.push("申报毛重必须大于 0");
  return errors;
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
