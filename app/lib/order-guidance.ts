import {
  orderBusinessStages,
  type OrderBusinessStage,
} from "./order-stage-flow";
import type { OrderModuleCode } from "./order-modules";

export type GuidanceModule = {
  module_code: OrderModuleCode;
  module_name: string;
  enabled: number;
  is_required: number;
  status: string;
  current_step_code: string | null;
  current_step_name: string | null;
  blocking_reason: string | null;
  assignee_name: string | null;
  progress_percent: number;
};

export type StageSnapshot = {
  stage: OrderBusinessStage;
  activeModules: GuidanceModule[];
  status: "completed" | "active" | "pending" | "skipped";
  progress: number;
};

export function buildStageSnapshots(orderStatus: string, modules: GuidanceModule[]) {
  const active = modules.filter(
    (module) =>
      module.enabled === 1 &&
      (module.is_required === 1 ||
        !["not_started", "not_applicable"].includes(module.status)),
  );
  const snapshots: StageSnapshot[] = orderBusinessStages.map((stage) => {
    const stageModules = stage.modules
      .map((code) => active.find((module) => module.module_code === code))
      .filter((module): module is GuidanceModule => Boolean(module));
    if (!stageModules.length)
      return { stage, activeModules: [], status: "skipped" as const, progress: 0 };
    const stageComplete = stageModules.every((module) =>
      isStageModuleComplete(stage.code, module),
    );
    const progress = Math.round(
      stageModules.reduce(
        (total, module) => total + stageModuleProgress(stage.code, module),
        0,
      ) / stageModules.length,
    );
    return {
      stage,
      activeModules: stageModules,
      status: stageComplete ? ("completed" as const) : ("pending" as const),
      progress,
    };
  });
  let activeIndex = snapshots.findIndex((snapshot) => snapshot.status === "pending");
  if (orderStatus === "submitted" || orderStatus === "confirmed") activeIndex = 1;
  if (orderStatus === "completed") activeIndex = snapshots.length - 1;
  if (activeIndex >= 0 && snapshots[activeIndex].status !== "completed") {
    snapshots[activeIndex] = { ...snapshots[activeIndex], status: "active" };
  }
  return snapshots;
}

function isStageModuleComplete(stageCode: string, module: GuidanceModule) {
  return module.status === "completed";
}

function stageModuleProgress(stageCode: string, module: GuidanceModule) {
  if (isStageModuleComplete(stageCode, module)) return 100;
  return Math.max(0, Math.min(100, module.progress_percent));
}

export function orderNextGuidance(input: {
  orderId: string;
  orderStatus: string;
  modules: GuidanceModule[];
}) {
  const { orderId, orderStatus, modules } = input;
  const href = `/admin/orders/${orderId}`;
  if (orderStatus === "cancelled")
    return {
      stage: orderBusinessStages[0],
      action: "查看已取消订单",
      owner: "无需处理",
      blocker: "订单已取消，工作流已经终止",
      href,
      moduleCode: null,
    };
  if (orderStatus === "completed")
    return {
      stage: orderBusinessStages[7],
      action: "查看订单复盘结果",
      owner: "订单负责人",
      blocker: null,
      href: `${href}/modules/review#module-business-data`,
      moduleCode: "review" as const,
    };
  const module = (code: OrderModuleCode) =>
    modules.find((item) => item.enabled === 1 && item.module_code === code);
  if (orderStatus === "draft") {
    const cargo = module("cargo");
    if (!cargo || cargo.status !== "completed")
      return moduleGuidance(orderId, orderBusinessStages[0], cargo, "完成货物复核与确认", "cargo");
    return {
      stage: orderBusinessStages[0],
      action: "复核委托资料并提交审批",
      owner: "订单创建人",
      blocker: null,
      href: `${href}/modules/consignment#module-business-data`,
      moduleCode: "consignment" as const,
    };
  }
  if (orderStatus === "submitted")
    return {
      stage: orderBusinessStages[1],
      action: "核对资料并审批订单",
      owner: "业务主管",
      blocker: null,
      href: `${href}/modules/assignment#module-business-data`,
      moduleCode: "assignment" as const,
    };
  if (orderStatus === "confirmed") {
    const assignment = module("assignment");
    if (!assignment || assignment.status !== "completed")
      return moduleGuidance(orderId, orderBusinessStages[1], assignment, "分配订单和模块负责人", "assignment");
    return {
      stage: orderBusinessStages[1],
      action: "核对分配并确认派单",
      owner: "操作主管",
      blocker: null,
      href: `${href}/modules/assignment#module-business-data`,
      moduleCode: "assignment" as const,
    };
  }
  const snapshots = buildStageSnapshots(orderStatus, modules);
  const current = snapshots.find((snapshot) => snapshot.status === "active");
  const pending = current?.activeModules.find((item) => item.status !== "completed");
  if (current && pending)
    return moduleGuidance(
      orderId,
      current.stage,
      pending,
      pending.current_step_name || `办理${pending.module_name}`,
      pending.module_code,
    );
  return {
    stage: orderBusinessStages[7],
    action: "进入复盘页确认订单完成",
    owner: "订单负责人",
    blocker: null,
    href: `${href}/modules/review#module-business-data`,
    moduleCode: "review" as const,
  };
}

function moduleGuidance(
  orderId: string,
  stage: OrderBusinessStage,
  module: GuidanceModule | undefined,
  action: string,
  fallbackCode: OrderModuleCode,
) {
  const code = module?.module_code ?? fallbackCode;
  return {
    stage,
    action,
    owner: module?.assignee_name || "待分配",
    blocker: module?.blocking_reason || (!module?.assignee_name ? "尚未分配负责人" : null),
    href: `/admin/orders/${orderId}/modules/${code}#module-business-data`,
    moduleCode: code,
  };
}
