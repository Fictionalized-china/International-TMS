import type { OrderModuleCode } from "./order-modules";

export type OrderBusinessStageCode =
  | "order_creation"
  | "review_assignment"
  | "domestic_execution"
  | "port_loading"
  | "outbound_transport"
  | "overseas_pickup"
  | "reconciliation"
  | "completion_review";

export type OrderBusinessStage = {
  code: OrderBusinessStageCode;
  title: string;
  shortTitle: string;
  description: string;
  modules: readonly OrderModuleCode[];
  minimumStatus: "draft" | "submitted" | "confirmed" | "in_execution";
  lockedReason: string;
};

// The eight stages are the stable business language shown to every role. The
// modules inside each stage stay dynamic and are enabled by the order services.
export const orderBusinessStages: readonly OrderBusinessStage[] = [
  {
    code: "order_creation",
    title: "1. 订单创建",
    shortTitle: "订单创建",
    description: "录入客户、线路、委托服务和多条货物，确认后提交审批。",
    modules: ["consignment", "cargo"],
    minimumStatus: "draft",
    lockedReason: "",
  },
  {
    code: "review_assignment",
    title: "2. 审核分配",
    shortTitle: "审核分配",
    description: "先由业务主管核对资料并审批订单；通过后，操作主管再派单并分配模块负责人。",
    modules: ["assignment"],
    minimumStatus: "submitted",
    lockedReason: "订单提交审批后开放审核分配。",
  },
  {
    code: "domestic_execution",
    title: "3. 国内运输",
    shortTitle: "国内运输",
    description: "安排从客户工厂到国内仓/口岸仓的国内段承运方、车型、车牌、司机、实际提货和到仓时间；仓库以实收数据作为后续配载和分摊依据。",
    modules: ["transport", "warehouse"],
    minimumStatus: "confirmed",
    lockedReason: "订单审批通过后开放国内运输。",
  },
  {
    code: "port_loading",
    title: "4. 装车与出库",
    shortTitle: "装车出库",
    description: "仓库实收清点完成后，操作员依据实收数据选择整车或拼车；整车直接装车出库，拼车从同线路待配载订单中组批后再装车出库。",
    modules: ["loading"],
    minimumStatus: "in_execution",
    lockedReason: "仓库完成实收登记并确认货齐后开放。",
  },
  {
    code: "outbound_transport",
    title: "5. 出境运输",
    shortTitle: "出境运输",
    description: "装车出库后，先通过文件、报关放行、费用和境外段车辆门禁；录入实际出境时间后才进入出境运输中。",
    modules: ["customs", "tracking"],
    minimumStatus: "in_execution",
    lockedReason: "确认派单并完成装车出库后办理。",
  },
  {
    code: "overseas_pickup",
    title: "6. 境外仓自提",
    shortTitle: "境外仓自提",
    description: "目的仓到仓、通知客户、预约提货、交付签收和异常处理。",
    modules: ["overseas_warehouse"],
    minimumStatus: "in_execution",
    lockedReason: "货物出境并到达目的仓后办理。",
  },
  {
    code: "reconciliation",
    title: "7. 对账结算",
    shortTitle: "对账结算",
    description: "确认应收应付，生成对账单，登记收付款并完成核销。",
    modules: ["costs"],
    minimumStatus: "in_execution",
    lockedReason: "订单进入执行后可持续预录，出境后完成确认和结算。",
  },
  {
    code: "completion_review",
    title: "8. 完成复盘",
    shortTitle: "完成复盘",
    description: "处理未关闭异常，复核时效、利润和资料后完成订单。",
    modules: ["exceptions", "review"],
    minimumStatus: "in_execution",
    lockedReason: "前序业务进入执行后开放异常处理和复盘。",
  },
] as const;

const statusRank: Record<string, number> = {
  draft: 0,
  submitted: 1,
  confirmed: 2,
  in_execution: 3,
  completed: 4,
};

const minimumRank: Record<OrderBusinessStage["minimumStatus"], number> = {
  draft: 0,
  submitted: 1,
  confirmed: 2,
  in_execution: 3,
};

export type OrderModuleAccess = {
  canView: true;
  canEdit: boolean;
  stage: OrderBusinessStage;
  reason: string | null;
};

export function orderStageForModule(moduleCode: string) {
  if (moduleCode === "documents") {
    return orderBusinessStages.find((stage) => stage.code === "outbound_transport");
  }
  return orderBusinessStages.find((stage) =>
    stage.modules.includes(moduleCode as OrderModuleCode),
  );
}

export type WorkflowStepPosition = {
  stepKey: string;
  stepName: string;
  sortOrder: number;
};

export type OrderModuleWorkflowStageAccess = {
  available: boolean;
  currentStepKey: string | null;
  currentStepName: string | null;
  requiredStepKey: string;
  requiredStepName: string;
  reason: string | null;
};

const moduleUnlockStep: Record<OrderModuleCode, OrderBusinessStageCode> = {
  consignment: "order_creation",
  cargo: "order_creation",
  assignment: "review_assignment",
  transport: "domestic_execution",
  warehouse: "domestic_execution",
  loading: "port_loading",
  documents: "outbound_transport",
  customs: "outbound_transport",
  tracking: "outbound_transport",
  overseas_warehouse: "overseas_pickup",
  costs: "order_creation",
  exceptions: "domestic_execution",
  review: "completion_review",
};

export function orderModuleWorkflowStageAccess(
  moduleCode: OrderModuleCode,
  currentStepKey: string | null,
  workflowSteps: WorkflowStepPosition[],
): OrderModuleWorkflowStageAccess {
  const requiredStepKey = moduleUnlockStep[moduleCode];
  const current = workflowSteps.find((step) => step.stepKey === currentStepKey) ?? null;
  const required = workflowSteps.find((step) => step.stepKey === requiredStepKey) ?? null;
  if (!current || !required) {
    return {
      available: true,
      currentStepKey,
      currentStepName: current?.stepName ?? null,
      requiredStepKey,
      requiredStepName:
        orderBusinessStages.find((stage) => stage.code === requiredStepKey)?.shortTitle ?? requiredStepKey,
      reason: null,
    };
  }
  const available = current.sortOrder >= required.sortOrder;
  return {
    available,
    currentStepKey,
    currentStepName: current.stepName,
    requiredStepKey,
    requiredStepName: required.stepName,
    reason: available
      ? null
      : `当前处于“${current.stepName}”，进入“${required.stepName}”后自动开放本模块`,
  };
}

export function orderModuleSequence(moduleCode: string) {
  let sequence = 0;
  for (const stage of orderBusinessStages) {
    for (const code of stage.modules) {
      sequence += 1;
      if (code === moduleCode) return sequence;
    }
  }
  return 999;
}

export function orderModuleAccess(
  orderStatus: string,
  moduleCode: string,
): OrderModuleAccess {
  const stage = orderStageForModule(moduleCode) ?? orderBusinessStages[0];
  if (["completed", "cancelled"].includes(orderStatus)) {
    return {
      canView: true,
      canEdit: false,
      stage,
      reason: orderStatus === "completed" ? "订单已完成，仅可查看" : "订单已取消，仅可查看",
    };
  }
  if (stage.code === "order_creation" && orderStatus !== "draft") {
    return {
      canView: true,
      canEdit: false,
      stage,
      reason: orderStatus === "submitted" ? "订单正在审批；退回草稿后才能修改" : "订单资料已经审批定版",
    };
  }
  if (moduleCode === "costs" && orderStatus === "draft") {
    return {
      canView: true,
      canEdit: true,
      stage,
      reason: null,
    };
  }
  const ready = (statusRank[orderStatus] ?? -1) >= minimumRank[stage.minimumStatus];
  return { canView: true, canEdit: ready, stage, reason: ready ? null : stage.lockedReason };
}

export function orderStageAccess(orderStatus: string, stage: OrderBusinessStage) {
  if (!stage.modules.length) {
    const ready = (statusRank[orderStatus] ?? -1) >= minimumRank[stage.minimumStatus];
    return { canView: true as const, canEdit: ready, stage, reason: ready ? null : stage.lockedReason };
  }
  return orderModuleAccess(orderStatus, stage.modules[0]);
}
