import { policyEnabled, policyPositions, type BusinessProcessPolicy } from "./business-process-policy";
import { isBossBusinessActor } from "./permission-blocks";
export const dailyTrackingKinds = ["pickup", "location", "transloading_vehicle", "queue", "exception"] as const;
export type DailyTrackingKind = typeof dailyTrackingKinds[number];
export const dailyTrackingKindLabels: Record<DailyTrackingKind,string> = { pickup:"国内提货",location:"每日位置",transloading_vehicle:"换装车号",queue:"口岸排队",exception:"运踪异常" };
export function dailyTrackingAccess(input:{policy:BusinessProcessPolicy;positionCode:string|null;roleCodes?:readonly string[];permissions:readonly string[];orderStatus:string;eventKind:string;pickupAt:string|null}) {
  if (!policyEnabled(input.policy,"tracking.daily_enabled")) return "全程每日运踪已停用，历史轨迹仍可查看";
  if (!isBossBusinessActor({positionCode:input.positionCode,roleCodes:input.roleCodes}) &&
      (!input.permissions.includes("tracking.daily.manage") || !policyPositions(input.policy,"tracking.positions").includes(input.positionCode ?? ""))) return "当前岗位没有每日运踪填写权";
  if (input.orderStatus !== "in_execution") return "订单尚未进入执行或已结束，不能新增每日运踪";
  if (!dailyTrackingKinds.includes(input.eventKind as DailyTrackingKind)) return "运踪类型无效；结构节点请使用原有节点登记入口";
  if (input.eventKind !== "pickup" && !input.pickupAt) return "请先登记实际提货，再填写每日在途运踪";
  return null;
}
export function dailyTrackingDescription(kind:DailyTrackingKind,notes:string,vehicle:string|null) {
  return [dailyTrackingKindLabels[kind],notes.trim(),vehicle?.trim() ? `车号：${vehicle.trim()}` : ""].filter(Boolean).join(" · ");
}
export function validTrackingEventTime(value:string,now:Date) {
  const time=Date.parse(value);
  return Number.isFinite(time) && time <= now.getTime()+5*60*1000;
}

/** MySQL dateStrings emits UTC DATETIME without a zone; never parse it in the host's local zone. */
export function storedTrackingTimestamp(value:string) {
  const normalized=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ","T")}Z` : value;
  return Date.parse(normalized);
}
