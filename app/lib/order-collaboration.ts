import type { OrderBusinessStageCode } from "./order-stage-flow";
import type { OrderModuleCode } from "./order-modules";

export type OrderCollaborationNotice = {
  title: string;
  progress: string;
};

type NoticeInput = {
  orderStatus: string;
  currentStepKey: string;
  moduleCode: OrderModuleCode | null;
  assigneeName?: string | null;
  currentUserId?: string | null;
  assigneeUserId?: string | null;
  taskAssigneeUserId?: string | null;
};

export function orderResponsibilityAssigneeLabel({
  currentStepKey,
  moduleCode,
  assigneeName,
}: {
  currentStepKey: string | null;
  moduleCode?: string | null;
  assigneeName?: string | null;
}) {
  const assigned = assigneeName?.trim();
  if (assigned) return assigned;
  if (
    ["warehouse_receiving", "port_loading", "overseas_pickup"].includes(currentStepKey ?? "") ||
    ["warehouse", "loading", "overseas_warehouse"].includes(moduleCode ?? "")
  ) {
    return "目标仓自动队列";
  }
  return "待分配";
}

function actor(role: string, assigneeName?: string | null) {
  const name = assigneeName?.trim();
  return name ? `${role}（${name}）` : role;
}

export function orderCollaborationNotice({
  orderStatus,
  currentStepKey,
  moduleCode,
  assigneeName,
  currentUserId,
  assigneeUserId,
  taskAssigneeUserId,
}: NoticeInput): OrderCollaborationNotice | null {
  if (["cancelled", "completed"].includes(orderStatus) || currentStepKey === "order_creation") {
    return null;
  }
  if (
    currentUserId &&
    [assigneeUserId, taskAssigneeUserId].some((userId) => userId === currentUserId)
  ) {
    return null;
  }

  switch (currentStepKey as OrderBusinessStageCode) {
    case "consignment_approval":
      return {
        title: `待${actor("业务主管", assigneeName)}审批`,
        progress: "当前进度：委托资料已提交，正在等待业务主管审核。",
      };
    case "task_assignment":
      return {
        title: `待${actor("操作主管", assigneeName)}分配任务`,
        progress: "当前进度：委托审核已通过，正在等待为各业务模块指派具体负责人。",
      };
    case "domestic_execution":
      return {
        title: `待${actor("操作岗", assigneeName)}安排国内运输`,
        progress: "当前进度：任务已分配，正在登记承运商、车辆、司机和计划到仓时间。",
      };
    case "warehouse_receiving":
      return {
        title: `待${actor("国内仓", assigneeName)}扫码入仓`,
        progress: "当前进度：国内运输已安排，货物正在国内段运输。",
      };
    case "port_loading":
      return {
        title: `待${actor("国内仓", assigneeName)}完成配载与装车出库`,
        progress: "当前进度：货物已入国内仓，正在等待配载、装车和出库交接。",
      };
    case "outbound_transport":
      return moduleCode === "customs"
        ? {
            title: `待${actor("单证岗", assigneeName)}完成报关放行`,
            progress: "当前进度：装车出库交接已完成，正在核对文件并办理报关。",
          }
        : {
            title: `待${actor("操作岗", assigneeName)}更新出境运输`,
            progress: "当前进度：报关已放行，正在登记出境运输与到达境外仓节点。",
          };
    case "overseas_pickup":
      return {
        title: `待${actor("境外仓与客户", assigneeName)}完成预约自提签收`,
        progress: "当前进度：货物进入境外仓协作环节，等待扫码到仓、客户预约和提货核销。",
      };
    case "reconciliation":
      return {
        title: "客服、业务、财务三方并行签核",
        progress: "三方没有先后顺序；各自通过后立即锁定自己的结果，全部完成后自动推进。",
      };
    case "completion_review":
      return {
        title: `待${actor("财务会计", assigneeName)}完成订单复盘`,
        progress: "当前进度：业务与结算环节已完成，正在核对费用、签收、异常和利润。",
      };
    default:
      return null;
  }
}
