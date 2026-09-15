export const overseasOperationStatusLabels: Record<string, string> = {
  waiting_arrival: "等待到仓",
  arrived: "目的仓已到仓",
  notified: "客户已通知",
  appointment: "客户已预约提货",
  picked_up: "客户已自提并签收",
  cancelled: "已取消",
};

export const overseasOperationProgress: Record<string, number> = {
  waiting_arrival: 0,
  arrived: 25,
  notified: 60,
  appointment: 75,
  picked_up: 100,
  cancelled: 0,
};

const customerOrderStatusLabels: Record<string, string> = {
  draft: "待补充委托资料",
  submitted: "待审核",
  confirmed: "已审核，待派单",
  in_execution: "运输执行中",
  completed: "已完成",
  cancelled: "已取消",
};

export function customerFacingOrderStatusLabel(
  orderStatus: string,
  overseasOperationStatus: string | null,
) {
  if (["arrived", "notified", "appointment"].includes(overseasOperationStatus ?? ""))
    return "已到仓待自提";
  if (overseasOperationStatus === "picked_up") return "已自提签收";
  return customerOrderStatusLabels[orderStatus] || orderStatus;
}

export function nextOverseasAction(status: string | null) {
  switch (status) {
    case "arrived":
      return "系统自动通知客户";
    case "notified":
      return "客户预约或到仓扫码自提";
    case "appointment":
      return "由境外仓扫码自提出库";
    case "picked_up":
      return "进入费用结算";
    default:
      return "确认目的仓到仓";
  }
}
