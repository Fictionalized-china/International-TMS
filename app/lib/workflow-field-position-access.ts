export function normalizeWorkflowFieldHandlerPositionCodes(
  values: readonly string[] | string | null | undefined,
) {
  const source = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(",")
      : [];
  return [...new Set(source.map((value) => value.trim()).filter(Boolean))].sort();
}

export function serializeWorkflowFieldHandlerPositionCodes(
  values: readonly string[] | string | null | undefined,
) {
  return normalizeWorkflowFieldHandlerPositionCodes(values).join(",");
}

export function canPositionHandleWorkflowField(
  configuredPositionCodes: readonly string[] | string | null | undefined,
  positionCode: string | null | undefined,
) {
  if (!positionCode) return false;
  return normalizeWorkflowFieldHandlerPositionCodes(configuredPositionCodes)
    .includes(positionCode);
}

export function canWriteWorkflowFieldAtCurrentNode(input: {
  configuredPositionCodes: readonly string[] | string | null | undefined;
  positionCode: string | null | undefined;
  canOperateCurrentNode: boolean;
  canOperateModule: boolean;
}) {
  return canPositionHandleWorkflowField(
    input.configuredPositionCodes,
    input.positionCode,
  ) && (input.canOperateCurrentNode || input.canOperateModule);
}

export function toggleWorkflowFieldHandlerPosition(
  configuredPositionCodes: readonly string[] | string | null | undefined,
  positionCode: string,
  enabled: boolean,
) {
  const next = new Set(
    normalizeWorkflowFieldHandlerPositionCodes(configuredPositionCodes),
  );
  if (enabled) next.add(positionCode);
  else next.delete(positionCode);
  return serializeWorkflowFieldHandlerPositionCodes([...next]);
}
