import type { OrderModuleCode } from "./order-modules";

export type OrderBusinessStageCode =
  | "order_creation"
  | "consignment_approval"
  | "task_assignment"
  | "domestic_execution"
  | "warehouse_receiving"
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

// These stages are the stable business language shown to every role. The
// modules inside each stage stay dynamic and are enabled by the order services.
export const orderBusinessStages: readonly OrderBusinessStage[] = [
  {
    code: "order_creation",
    title: "1. 订单创建与委托",
    shortTitle: "订单创建",
    description: "从已接受报价继承客户、整车/拼车和应收价格，补充提货、货物、目的仓和委托单后提交审批。",
    modules: ["consignment", "cargo"],
    minimumStatus: "draft",
    lockedReason: "",
  },
  {
    code: "consignment_approval",
    title: "2. 委托审核",
    shortTitle: "委托审核",
    description: "业务主管在委托信息中查看订单与货物资料，审批通过后进入任务分配。",
    modules: [],
    minimumStatus: "submitted",
    lockedReason: "订单提交审批后开放委托审核。",
  },
  {
    code: "task_assignment",
    title: "3. 任务分配",
    shortTitle: "任务分配",
    description: "操作主管按模组选择具体岗位和具体人员，确认派单后才进入国内运输。",
    modules: ["assignment"],
    minimumStatus: "confirmed",
    lockedReason: "委托审核通过后开放任务分配。",
  },
  {
    code: "domestic_execution",
    title: "4. 国内运输",
    shortTitle: "国内运输",
    description: "选择国内承运商、车辆和司机，登记提货及到达国内仓；同一订单允许多车提货但只生成一张国内运单。",
    modules: ["transport"],
    minimumStatus: "in_execution",
    lockedReason: "操作主管确认派单后开放国内运输。",
  },
  {
    code: "warehouse_receiving",
    title: "5. 国内仓入库",
    shortTitle: "仓库入库",
    description: "国内仓按预计与实收数据完成清点、标签、库区和库位登记，并选择货齐或异常。",
    modules: ["warehouse"],
    minimumStatus: "in_execution",
    lockedReason: "国内运输到仓后开放仓库入库。",
  },
  {
    code: "port_loading",
    title: "6. 出口准备与装车出库",
    shortTitle: "出口准备",
    description: "仓库确认货齐后填写口岸、清关地和选填线路说明；按报价类型自动进入整车运输单或PZ配载单，再办理报关、装车与出库。",
    modules: ["loading"],
    minimumStatus: "in_execution",
    lockedReason: "仓库完成实收登记并确认货齐后开放。",
  },
  {
    code: "outbound_transport",
    title: "7. 出境运输",
    shortTitle: "出境运输",
    description: "装车出库后，先通过文件、报关放行、费用和境外段车辆门禁；录入实际出境时间后才进入出境运输中。",
    modules: ["customs", "tracking"],
    minimumStatus: "in_execution",
    lockedReason: "确认派单并完成装车出库后办理。",
  },
  {
    code: "overseas_pickup",
    title: "8. 境外仓与自提",
    shortTitle: "境外仓自提",
    description: "目的仓到仓、通知客户、预约提货、交付签收和异常处理。",
    modules: ["overseas_warehouse"],
    minimumStatus: "in_execution",
    lockedReason: "货物出境并到达目的仓后办理。",
  },
  {
    code: "reconciliation",
    title: "9. 对账结算",
    shortTitle: "对账结算",
    description: "确认应收应付，生成对账单，登记收付款并完成核销。",
    modules: ["costs"],
    minimumStatus: "in_execution",
    lockedReason: "订单进入执行后可持续预录，出境后完成确认和结算。",
  },
  {
    code: "completion_review",
    title: "10. 完成复盘",
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
  assignment: "task_assignment",
  transport: "domestic_execution",
  warehouse: "warehouse_receiving",
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
