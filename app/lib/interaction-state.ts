export type RouterActivityState = "idle" | "loading" | "submitting";

export function hasActiveInteraction(
  navigationState: RouterActivityState,
  fetcherStates: RouterActivityState[],
) {
  return navigationState !== "idle" || fetcherStates.some((state) => state !== "idle");
}

export function connectionStatusLabel(input: {
  online: boolean;
  syncing: boolean;
}) {
  if (!input.online) return "离线，当前数据可能已过期";
  if (input.syncing) return "正在同步页面数据…";
  return "网络在线";
}
