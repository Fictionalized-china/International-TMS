import { isBossBusinessActor } from "./permission-blocks";

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
  roleCodes?: readonly string[],
) {
  if (isBossBusinessActor({ positionCode, roleCodes })) return true;
  if (!positionCode) return false;
  return normalizeWorkflowFieldHandlerPositionCodes(configuredPositionCodes)
    .includes(positionCode);
}

export function canWriteWorkflowFieldAtCurrentNode(input: {
  configuredPositionCodes: readonly string[] | string | null | undefined;
  positionCode: string | null | undefined;
  roleCodes?: readonly string[];
  canOperateCurrentNode: boolean;
  canOperateModule: boolean;
  canRemediateRequiredField?: boolean;
}) {
  return canPositionHandleWorkflowField(
    input.configuredPositionCodes,
    input.positionCode,
    input.roleCodes,
  ) && (
    input.canOperateCurrentNode ||
    input.canOperateModule ||
    input.canRemediateRequiredField === true
  );
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
