export type OrderModuleCode =
  | "consignment"
  | "cargo"
  | "assignment"
  | "warehouse"
  | "customs"
  | "documents"
  | "transport"
  | "loading"
  | "tracking"
  | "overseas_warehouse"
  | "costs"
  | "exceptions"
  | "review";

export type OrderModuleStep = { code: string; name: string };
export type OrderModuleDefinition = {
  code: OrderModuleCode;
  name: string;
  description: string;
  icon: string;
  required: boolean;
  services?: string[];
  businessTypes?: string[];
  steps: OrderModuleStep[];
};

// The shared business sequence is intentionally independent from the array used
// to declare modules. All order overviews, workflow snapshots and work pages
// should use this order so the screen reads from preparation to completion.
export const orderModuleFlowOrder: readonly OrderModuleCode[] = [
  "consignment",
  "cargo",
  "assignment",
  "transport",
  "warehouse",
  "loading",
  "documents",
  "customs",
  "tracking",
  "overseas_warehouse",
  "costs",
  "exceptions",
  "review",
] as const;

export const orderModuleDefinitions: OrderModuleDefinition[] = [
  {
    code: "consignment",
    name: "委托信息",
    description: "客户委托、收发货信息、预约提货和境外目的仓",
    icon: "▧",
    required: true,
    steps: [
      { code: "draft", name: "资料录入" },
      { code: "submitted", name: "提请审批" },
      { code: "approved", name: "审核通过" },
    ],
  },
  {
    code: "cargo",
    name: "货物信息",
    description: "货物明细、包装、重量体积、HS Code与图片（常驻查看，不阻断工作流）",
    icon: "◇",
    required: false,
    steps: [
      { code: "entered", name: "货物录入" },
      { code: "verified", name: "货物复核" },
      { code: "confirmed", name: "货物确认" },
    ],
  },
  {
    code: "assignment",
    name: "任务分配",
    description: "为跟单、仓库、报关、单证、配载与运踪岗位派发任务",
    icon: "♧",
    required: true,
    steps: [
      { code: "pending", name: "待分配" },
      { code: "partial", name: "部分分配" },
      { code: "assigned", name: "分配完成" },
    ],
  },
  {
    code: "warehouse",
    name: "仓库作业",
    description: "实际收货、验货、称重量方、入库并确认货齐；货齐后国内运输阶段结束",
    icon: "▥",
    required: true,
    businessTypes: ["ftl", "ltl"],
    steps: [
      { code: "waiting", name: "等待到货" },
      { code: "receiving", name: "到仓收货" },
      { code: "ready", name: "收货清点完成" },
    ],
  },
  {
    code: "customs",
    name: "报关作业",
    description: "出库后、确认出境前办理起运地或过境地申报、查验和放行；未放行会阻断出境",
    icon: "▦",
    required: true,
    services: ["customs", "destination_customs"],
    steps: [
      { code: "documents", name: "等待资料" },
      { code: "ready", name: "资料齐全" },
      { code: "declared", name: "完成申报" },
      { code: "review", name: "海关审核" },
      { code: "released", name: "海关放行" },
    ],
  },
  {
    code: "documents",
    name: "文件中心",
    description: "汇总各业务节点上传的委托、报关、运输、签收与结算文件，并统一审核归档",
    icon: "▤",
    required: false,
    steps: [
      { code: "waiting", name: "等待上传" },
      { code: "checking", name: "资料检查" },
      { code: "approved", name: "审核通过" },
      { code: "archived", name: "文件归档" },
    ],
  },
  {
    code: "transport",
    name: "运输安排",
    description: "派单后安排从客户工厂到国内仓/口岸仓的提货车辆、司机、承运方和到仓时间；不在国内段做拼车配载",
    icon: "▰",
    required: true,
    steps: [
      { code: "planning", name: "运输安排" },
      { code: "arranged", name: "已录入运输安排" },
      { code: "ready", name: "等待国内提货" },
      { code: "completed", name: "安排完成" },
    ],
  },
  {
    code: "loading",
    name: "装车与出库",
    description: "国内运输完成后按报价类型自动分支；整车一票一车装车出库，拼车按配载运输单整批装车出库",
    icon: "▱",
    required: true,
    steps: [
      { code: "waiting", name: "等待生成运输方案" },
      { code: "selecting", name: "已生成整车/拼车运输单" },
      { code: "planned", name: "车辆与装载已安排" },
      { code: "loading", name: "拣货装车" },
      { code: "confirmed", name: "装车出库交接完成" },
    ],
  },
  {
    code: "tracking",
    name: "运输执行与跟踪",
    description: "通过出境门禁后，按顺序记录到达出境口岸、出境、国外入境、目的地清关和境外目的仓到仓；换装与转关按实际情况选填",
    icon: "⌾",
    required: true,
    steps: [
      { code: "waiting", name: "等待到达出境口岸" },
      { code: "transit", name: "运输在途" },
      { code: "customs_cleared", name: "目的地清关完成" },
      { code: "arrived", name: "到达境外目的仓" },
    ],
  },
  {
    code: "overseas_warehouse",
    name: "境外仓自提",
    description: "境外目的仓完成入库后自动通知客户，客户到仓扫码核对并确认收货，一次完成自提、出库和签收",
    icon: "仓",
    required: true,
    services: ["destination_warehouse"],
    steps: [
      { code: "waiting_arrival", name: "等待到仓" },
      { code: "arrived", name: "目的仓已到仓" },
      { code: "notified", name: "客户已通知" },
      { code: "signed", name: "扫码自提签收" },
    ],
  },
  {
    code: "costs",
    name: "费用结算",
    description: "费用预录、应收应付、审批、收付款与业务财务锁；配载成本分摊只影响内部毛利和应付，不改客户应收",
    icon: "▣",
    required: true,
    steps: [
      { code: "waiting", name: "等待录入" },
      { code: "business_review", name: "业务审核" },
      { code: "finance_review", name: "财务审核" },
      { code: "settling", name: "结算处理" },
      { code: "settled", name: "结算完成" },
    ],
  },
  {
    code: "exceptions",
    name: "异常处理",
    description: "资料、货物、报关、配载、运输与费用异常",
    icon: "△",
    required: false,
    steps: [
      { code: "monitoring", name: "异常监控" },
      { code: "processing", name: "异常处理" },
      { code: "review", name: "结果复核" },
      { code: "resolved", name: "异常关闭" },
    ],
  },
  {
    code: "review",
    name: "订单复盘",
    description: "复核时效、费用、利润、异常和资料完整性后关闭订单",
    icon: "复",
    required: true,
    steps: [
      { code: "waiting", name: "等待复盘" },
      { code: "reviewing", name: "复盘中" },
      { code: "confirmed", name: "复盘确认" },
    ],
  },
];

export function enabledOrderModules(businessType: string, services: string[]) {
  const selected = new Set(services);
  return orderModuleDefinitions.map((definition) => ({
    ...definition,
    enabled:
      (!definition.services ||
        definition.services.some((x) => selected.has(x))) &&
      (!definition.businessTypes ||
        definition.businessTypes.includes(businessType)),
  }));
}

export function orderModuleDefinition(code: string) {
  return orderModuleDefinitions.find((item) => item.code === code);
}

export function isRuntimeMandatoryOrderModule(
  businessType: string,
  moduleCode: string,
) {
  return ["ftl", "ltl"].includes(businessType) && moduleCode === "warehouse";
}

export type OrderWorkflowModuleSnapshot = {
  module_code: OrderModuleCode;
  module_name: string;
  enabled: number;
  is_required: number;
  status: string;
  current_step_name: string | null;
  progress_percent: number;
};

export function composeOrderWorkflow<
  T extends OrderWorkflowModuleSnapshot,
>(modules: T[]) {
  const order = new Map(
    orderModuleFlowOrder.map((moduleCode, index) => [moduleCode, index]),
  );
  return modules
    .filter(
      (module) =>
        module.enabled === 1 &&
        (module.is_required === 1 ||
          !["not_started", "not_applicable"].includes(module.status)),
    )
    .sort(
      (left, right) =>
        (order.get(left.module_code) ?? 999) -
        (order.get(right.module_code) ?? 999),
    );
}

export function composedWorkflowProgress(
  modules: OrderWorkflowModuleSnapshot[],
) {
  const active = composeOrderWorkflow(modules);
  if (!active.length) return 0;
  return Math.round(
    active.reduce(
      (total, module) => total + Math.max(0, Math.min(100, module.progress_percent)),
      0,
    ) / active.length,
  );
}

export const moduleStatusLabels: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  blocked: "已阻断",
  completed: "已完成",
  not_applicable: "未启用",
  exception: "异常",
};
