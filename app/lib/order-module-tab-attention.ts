export type OrderModuleTabAttention = "required" | "action" | null;

export function orderModuleTabAttention(
  moduleCode: string | null,
  hasRequiredMissing: boolean,
): OrderModuleTabAttention {
  if (!hasRequiredMissing) return null;

  // 运输节点在报关放行后才可办理，不能把上游门禁误报为本页待填。
  if (moduleCode === "tracking") return null;

  // 报关是当前可直接处理的上游动作，用明确待办代替含义不清的红星。
  if (moduleCode === "customs") return "action";

  return "required";
}
