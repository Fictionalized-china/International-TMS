import type { OrderModuleCode } from "./order-modules";

export type PositionPortalLink = {
  label: string;
  description: string;
  href: string;
  permission?: string;
};

export type PositionPortalConfig = {
  code: string;
  title: string;
  description: string;
  viewAreas: string[];
  operateAreas: string[];
  moduleCodes: OrderModuleCode[];
  quickLinks: PositionPortalLink[];
};

type PortalUser = {
  positionCode: string | null;
  roleCodes: string[];
  permissions: string[];
};

const allModules: OrderModuleCode[] = [
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
];

const portalConfigs: Record<string, PositionPortalConfig> = {
  BOSS: {
    code: "BOSS",
    title: "老板门户",
    description: "查看全局经营、订单推进、费用利润、异常和人员执行情况。",
    viewAreas: ["全部订单与运单", "经营与利润", "费用结算", "客户与承运商", "流程、权限与审计"],
    operateAreas: ["订单审批与派单", "重大异常处理", "费用复核", "工作流与权限配置"],
    moduleCodes: allModules,
    quickLinks: [
      { label: "经营总览", description: "查看全局经营指标", href: "/admin" },
      { label: "订单工作台", description: "查看所有订单下一步", href: "/admin/orders", permission: "order.view" },
      { label: "费用结算", description: "查看应收应付与利润", href: "/admin/billing", permission: "billing.view" },
      { label: "业务工作流", description: "配置流程和字段", href: "/admin/workflow", permission: "workflow.view" },
      { label: "审计日志", description: "追溯关键操作", href: "/admin/audit", permission: "audit.view" },
    ],
  },
  DEVELOPER: {
    code: "DEVELOPER",
    title: "开发者门户",
    description: "维护业务工作流、字段积木、主数据和系统配置。",
    viewAreas: ["业务工作流", "基础数据", "岗位与权限", "审计日志"],
    operateAreas: ["编辑流程模板", "配置节点字段", "维护主数据与系统设置"],
    moduleCodes: [],
    quickLinks: [
      { label: "业务工作流", description: "编辑模板、节点与字段", href: "/admin/workflow", permission: "workflow.view" },
      { label: "基础数据", description: "维护业务主数据", href: "/admin/master-data", permission: "master.view" },
      { label: "岗位管理", description: "检查岗位权限", href: "/admin/positions", permission: "user.view" },
      { label: "角色权限", description: "维护系统角色", href: "/admin/roles", permission: "role.view" },
    ],
  },
  DOC: {
    code: "DOC",
    title: "单证门户",
    description: "集中处理发运文件、报关申报资料和放行记录。",
    viewAreas: ["本人负责订单", "文件中心", "报关申报", "运输节点"],
    operateAreas: ["上传与审核文件", "维护多张报关单", "登记海关审核和放行"],
    moduleCodes: ["documents", "customs"],
    quickLinks: [
      { label: "单证待办", description: "处理文件资料", href: "/admin/workbenches/documents", permission: "order.view" },
      { label: "报关待办", description: "处理申报与放行", href: "/admin/workbenches/customs", permission: "order.view" },
      { label: "运单列表", description: "核对关联运单", href: "/admin/shipments", permission: "shipment.view" },
    ],
  },
  CS: {
    code: "CS",
    title: "客服门户",
    description: "维护客户委托、订单资料、客户反馈和全程跟踪。",
    viewAreas: ["客户资料", "本人负责订单", "运输轨迹", "费用状态"],
    operateAreas: ["录入委托与货物", "更新客户可见轨迹", "处理客户异常", "费用预录"],
    moduleCodes: ["consignment", "cargo", "tracking", "overseas_warehouse", "costs", "exceptions"],
    quickLinks: [
      { label: "我的待办", description: "按下一步处理订单", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "客户管理", description: "查看客户与地址簿", href: "/admin/customers", permission: "customer.view" },
      { label: "运踪待办", description: "更新运输节点", href: "/admin/workbenches/tracking", permission: "order.view" },
    ],
  },
  FINANCE: {
    code: "FINANCE",
    title: "财务门户",
    description: "处理应收应付、审核锁定、对账、收付款和利润核算。",
    viewAreas: ["订单摘要", "应收应付", "费用与利润", "审计记录"],
    operateAreas: ["费用审核与锁定", "对账与开票", "收付款与核销", "结算复核"],
    moduleCodes: ["costs", "review"],
    quickLinks: [
      { label: "费用待办", description: "处理订单费用", href: "/admin/workbenches/costs", permission: "order.view" },
      { label: "费用结算", description: "进入财务结算中心", href: "/admin/billing", permission: "billing.view" },
      { label: "审计日志", description: "核对关键财务操作", href: "/admin/audit", permission: "audit.view" },
    ],
  },
  SALES: {
    code: "SALES",
    title: "业务员门户",
    description: "管理客户、报价和本人订单，完成下单前后的商务资料。",
    viewAreas: ["本人客户", "销售与报价", "本人订单", "应收预录状态"],
    operateAreas: ["维护客户", "制作报价", "创建订单", "录入委托、货物和应收预估"],
    moduleCodes: ["consignment", "cargo", "costs"],
    quickLinks: [
      { label: "客户管理", description: "客户与常用地址", href: "/admin/customers", permission: "customer.view" },
      { label: "询价报价", description: "维护客户报价", href: "/admin/quotations", permission: "quote.view" },
      { label: "运输订单", description: "创建并跟进本人订单", href: "/admin/orders", permission: "order.view" },
    ],
  },
  OVERSEAS: {
    code: "OVERSEAS",
    title: "海外人员门户",
    description: "处理境外运输跟踪、目的仓到仓、通知和客户提货。",
    viewAreas: ["本人负责订单", "出境后轨迹", "境外目的仓", "海外异常"],
    operateAreas: ["更新境外轨迹", "确认目的仓到仓", "通知与预约提货", "登记提货完成"],
    moduleCodes: ["tracking", "overseas_warehouse", "exceptions"],
    quickLinks: [
      { label: "海外待办", description: "处理到仓和自提", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "运踪待办", description: "更新境外运输节点", href: "/admin/workbenches/tracking", permission: "order.view" },
      { label: "运单列表", description: "查看出境运单", href: "/admin/shipments", permission: "shipment.view" },
    ],
  },
  CONTAINER: {
    code: "CONTAINER",
    title: "箱管门户",
    description: "处理仓库实收、货齐确认、拼车配载、装车和出库交接。",
    viewAreas: ["待到仓订单", "仓库实收", "待配载订单", "配载批次与车辆"],
    operateAreas: ["扫码收货与复核", "确认齐套", "拼车组批与车辆安排", "装车出库"],
    moduleCodes: ["warehouse", "loading"],
    quickLinks: [
      { label: "仓库待办", description: "查看本岗位订单", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "拼车配载", description: "跨订单高级配载", href: "/admin/loading", permission: "order.view" },
      { label: "运输订单", description: "查看订单状态", href: "/admin/orders", permission: "order.view" },
    ],
  },
  SALES_ASSISTANT: {
    code: "SALES_ASSISTANT",
    title: "业务助理门户",
    description: "协助业务员整理客户资料、创建订单和补充委托信息。",
    viewAreas: ["客户资料", "本人协作订单", "报价摘要", "费用预录状态"],
    operateAreas: ["维护客户资料", "创建和补充订单", "录入货物", "费用预录"],
    moduleCodes: ["consignment", "cargo", "costs"],
    quickLinks: [
      { label: "客户管理", description: "维护客户资料", href: "/admin/customers", permission: "customer.view" },
      { label: "运输订单", description: "创建并补充订单", href: "/admin/orders", permission: "order.view" },
      { label: "我的待办", description: "处理分配给我的订单", href: "/admin/workbenches/tasks", permission: "order.view" },
    ],
  },
  OPERATION: {
    code: "OPERATION",
    title: "操作门户",
    description: "从审核派单到境外到仓统筹订单执行，是汽运主流程的核心岗位。",
    viewAreas: ["全部执行订单", "任务与负责人", "仓库、配载、单证、报关和运踪", "异常与费用状态"],
    operateAreas: ["审批与派单", "国内运输安排", "协调仓库与配载", "单证报关与运踪", "异常处理"],
    moduleCodes: ["assignment", "transport", "warehouse", "loading", "documents", "customs", "tracking", "overseas_warehouse", "costs", "exceptions", "review"],
    quickLinks: [
      { label: "业务待办", description: "按下一步处理订单", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "运输订单", description: "查看全部执行订单", href: "/admin/orders", permission: "order.view" },
      { label: "运单列表", description: "查看运输资源与轨迹", href: "/admin/shipments", permission: "shipment.view" },
      { label: "拼车配载", description: "处理跨订单高级配载", href: "/admin/loading", permission: "order.view" },
    ],
  },
  BUSINESS_ROUTE: {
    code: "BUSINESS_ROUTE",
    title: "商务/航线门户",
    description: "维护承运商、线路、报价成本和车辆方案。",
    viewAreas: ["承运商", "物流产品与线路", "订单运输需求", "配载与成本"],
    operateAreas: ["维护承运商", "维护线路产品", "协助运输与配载方案", "录入成本"],
    moduleCodes: ["transport", "loading", "costs"],
    quickLinks: [
      { label: "承运商管理", description: "维护承运资源", href: "/admin/carriers", permission: "carrier.view" },
      { label: "物流产品", description: "维护线路与价格", href: "/admin/logistics-products", permission: "pricing.view" },
      { label: "拼车配载", description: "查看批次和车辆", href: "/admin/loading", permission: "order.view" },
    ],
  },
  BOOKING: {
    code: "BOOKING",
    title: "订舱人员门户",
    description: "处理运输资源预订、承运商协同、发运资料和运单。",
    viewAreas: ["本人负责订单", "承运商与运输安排", "订舱和运单", "发运文件"],
    operateAreas: ["录入运输与订舱安排", "维护运单", "协助配载", "核对发运文件"],
    moduleCodes: ["transport", "loading", "documents"],
    quickLinks: [
      { label: "运输待办", description: "处理分配任务", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "运单列表", description: "维护运输运单", href: "/admin/shipments", permission: "shipment.view" },
      { label: "承运商管理", description: "选择承运资源", href: "/admin/carriers", permission: "carrier.view" },
    ],
  },
};

export function positionPortalForUser(user: PortalUser): PositionPortalConfig {
  if (user.roleCodes.some((code) => code === "owner" || code === "boss")) {
    return portalConfigs.BOSS;
  }
  return portalConfigs[user.positionCode ?? ""] ?? {
    code: "GENERAL",
    title: "岗位门户",
    description: "查看分配给本账号的订单和下一步待办。",
    viewAreas: ["本人负责订单", "本人待办"],
    operateAreas: ["按已授权模块办理业务"],
    moduleCodes: allModules,
    quickLinks: [
      { label: "我的待办", description: "查看分配给我的任务", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "运输订单", description: "查看订单", href: "/admin/orders", permission: "order.view" },
    ],
  };
}

export function visiblePortalLinks(config: PositionPortalConfig, permissions: string[]) {
  return config.quickLinks.filter(
    (link) => !link.permission || permissions.includes(link.permission),
  );
}

export function moduleManagePermission(moduleCode: string) {
  return `order.module.${moduleCode}.manage`;
}

export function canManageOrderModule(user: PortalUser, moduleCode: string) {
  return (
    user.roleCodes.some((code) => code === "owner" || code === "boss") ||
    user.permissions.includes(moduleManagePermission(moduleCode))
  );
}

export const positionPortalConfigs = Object.values(portalConfigs);
