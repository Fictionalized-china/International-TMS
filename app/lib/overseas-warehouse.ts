export const overseasOperationStatusLabels: Record<string, string> = {
  waiting_arrival: "等待到仓",
  arrived: "目的仓已到仓",
  notified: "客户已通知",
  appointment: "已预约提货",
  picked_up: "客户自提并签收，运输完成",
  cancelled: "已取消",
};

export const overseasOperationProgress: Record<string, number> = {
  waiting_arrival: 0,
  arrived: 25,
  notified: 50,
  appointment: 75,
  picked_up: 100,
  cancelled: 0,
};

export function nextOverseasAction(status: string | null) {
  switch (status) {
    case "arrived":
      return "通知客户到仓";
    case "notified":
      return "登记提货预约";
    case "appointment":
      return "确认客户自提并签收";
    case "picked_up":
      return "已完成";
    default:
      return "确认目的仓到仓";
  }
}
