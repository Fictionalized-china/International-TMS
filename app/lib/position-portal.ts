import type { OrderModuleCode } from "./order-modules";
import { canAccessSettlementWorkbench } from "./billing-access";

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
      { label: "岗位与账号", description: "检查账号任岗", href: "/admin/positions", permission: "user.view" },
      { label: "岗位权限", description: "维护岗位默认权限", href: "/admin/roles", permission: "role.view" },
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
      { label: "配载订单", description: "处理分配给本人的整批单证与报关", href: "/admin/loading", permission: "transport.batch.assigned.view" },
      { label: "运输单据", description: "核对关联运单", href: "/admin/shipments", permission: "shipment.view" },
    ],
  },
  CS: {
    code: "CS",
    title: "客服门户",
    description: "维护订单资料、应收应付、账单、对账和客户收款协同。",
    viewAreas: ["全部客户资料", "本人负责订单", "应收应付", "账单状态"],
    operateAreas: ["录入委托与货物", "维护订单费用", "对账与收款核销"],
    moduleCodes: ["consignment", "cargo", "costs"],
    quickLinks: [
      { label: "我的待办", description: "按下一步处理订单", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "客户管理", description: "查看客户与地址簿", href: "/admin/customers", permission: "customer.view" },
      { label: "费用结算", description: "处理账单、对账与收款", href: "/admin/billing", permission: "billing.view" },
    ],
  },
  TRACKING: {
    code: "TRACKING",
    title: "运踪岗门户",
    description: "按订单节点录入车辆信息并更新每日运踪。",
    viewAreas: ["本人负责订单", "车辆与运单", "最新运输位置"],
    operateAreas: ["录入车辆资料", "更新每日运踪", "维护客户可见轨迹"],
    moduleCodes: ["tracking"],
    quickLinks: [
      { label: "运踪待办", description: "更新当前运输节点", href: "/admin/workbenches/tracking", permission: "order.view" },
      { label: "运输单据", description: "查看车辆和轨迹", href: "/admin/shipments", permission: "shipment.view" },
    ],
  },
  FINANCE_ACCOUNTING: {
    code: "FINANCE_ACCOUNTING",
    title: "财务会计岗门户",
    description: "处理应收应付、审核锁定、对账、利润核算和数据导出。",
    viewAreas: ["订单摘要", "应收应付", "费用与利润", "审计记录"],
    operateAreas: ["费用审核与锁定", "对账与开票", "统计导出", "结算复核"],
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
    operateAreas: ["维护本人客户", "制作报价", "查看本人订单全程"],
    moduleCodes: [],
    quickLinks: [
      { label: "客户管理", description: "客户与常用地址", href: "/admin/customers", permission: "customer.view" },
      { label: "询价报价", description: "维护客户报价", href: "/admin/quotations", permission: "quote.view" },
      { label: "订单中心", description: "创建并跟进本人订单", href: "/admin/orders", permission: "order.view" },
    ],
  },
  BUSINESS_SUPERVISOR: {
    code: "BUSINESS_SUPERVISOR",
    title: "业务主管门户",
    description: "查看全部业务订单，并审批明确提交给本人的委托资料。",
    viewAreas: ["全部订单", "委托资料", "报价与客户摘要"],
    operateAreas: ["审批本人待办", "指定下一步操作主管"],
    moduleCodes: ["consignment"],
    quickLinks: [
      { label: "审批待办", description: "审批提交给本人的委托", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "订单中心", description: "只读查看全部订单", href: "/admin/orders", permission: "order.view" },
    ],
  },
  OPERATION_SUPERVISOR: {
    code: "OPERATION_SUPERVISOR",
    title: "操作主管门户",
    description: "接收业务主管转交的订单，分配具体操作岗，并审核拼车配载单。",
    viewAreas: ["本人审批订单", "本人审批配载单", "执行人员与进度"],
    operateAreas: ["任务分配", "拼车配载审批", "指定整单操作负责人"],
    moduleCodes: ["assignment", "loading"],
    quickLinks: [
      { label: "任务分配", description: "处理本人待派订单", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "配载审批", description: "审核仓库提交的拼车配载单", href: "/admin/loading", permission: "order.view" },
    ],
  },
  OVERSEAS: {
    code: "OVERSEAS",
    title: "海外人员门户",
    description: "处理境外运输跟踪、目的仓到仓、通知和客户提货。",
    viewAreas: ["本人负责订单", "出境后轨迹", "境外目的仓", "海外异常"],
    operateAreas: ["更新境外轨迹", "确认目的仓到仓", "通知客户", "办理自提签收"],
    moduleCodes: ["tracking", "overseas_warehouse", "exceptions"],
    quickLinks: [
      { label: "海外待办", description: "处理到仓和自提", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "运踪待办", description: "更新境外运输节点", href: "/admin/workbenches/tracking", permission: "order.view" },
      { label: "运输单据", description: "查看出境运单", href: "/admin/shipments", permission: "shipment.view" },
    ],
  },
  LOADING: { code: "LOADING", title: "前端配载岗", description: "仅用于岗位与薪资归类。", viewAreas: [], operateAreas: [], moduleCodes: [], quickLinks: [] },
  SALES_ASSISTANT: {
    code: "SALES_ASSISTANT",
    title: "业务助理门户",
    description: "协助业务员整理客户资料、创建订单和补充委托信息。",
    viewAreas: ["客户资料", "本人协作订单", "报价摘要", "费用预录状态"],
    operateAreas: ["维护客户资料", "创建和补充订单", "录入货物", "费用预录"],
    moduleCodes: ["consignment", "cargo", "costs"],
    quickLinks: [
      { label: "客户管理", description: "维护客户资料", href: "/admin/customers", permission: "customer.view" },
      { label: "订单中心", description: "创建并补充订单", href: "/admin/orders", permission: "order.view" },
      { label: "我的待办", description: "处理分配给我的订单", href: "/admin/workbenches/tasks", permission: "order.view" },
    ],
  },
  OPERATION: {
    code: "OPERATION",
    title: "操作门户",
    description: "连续负责分配给本人的运输安排、车辆轨迹和执行异常。",
    viewAreas: ["派给本人的订单", "本人负责配载单", "运输资源", "轨迹和异常"],
    operateAreas: ["国内运输安排", "登记全程运踪", "异常处理"],
    moduleCodes: ["transport", "tracking", "exceptions"],
    quickLinks: [
      { label: "业务待办", description: "按下一步处理订单", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "订单中心", description: "查看全部执行订单", href: "/admin/orders", permission: "order.view" },
      { label: "运输单据", description: "查看运输资源与轨迹", href: "/admin/shipments", permission: "shipment.view" },
      { label: "配载单跟踪", description: "处理分配给本人的整批运输", href: "/admin/loading", permission: "transport.batch.assigned.view" },
    ],
  },
  BUSINESS_ROUTE: {
    code: "BUSINESS_ROUTE",
    title: "商务报价岗",
    description: "仅用于岗位与薪资归类。",
    viewAreas: [],
    operateAreas: [],
    moduleCodes: [],
    quickLinks: [],
  },
  CASHIER: { code: "CASHIER", title: "出纳岗门户", description: "登记收付款并完成核销。", viewAreas: ["全部订单摘要", "应收应付", "收付款流水"], operateAreas: ["登记收付款", "对账单核销", "数据导出"], moduleCodes: [], quickLinks: [{ label: "费用结算", description: "登记流水与核销", href: "/admin/billing", permission: "billing.view" }] },
  HR_ADMIN: { code: "HR_ADMIN", title: "人事行政岗门户", description: "维护组织、账号、岗位和权限。", viewAreas: ["组织架构", "岗位与账号", "岗位权限", "审计日志"], operateAreas: ["开通与停用账号", "配置岗位", "增减权限积木"], moduleCodes: [], quickLinks: [{ label: "组织与权限", description: "开通账号并维护岗位归属", href: "/admin/positions", permission: "user.view" }, { label: "岗位权限", description: "配置岗位和账号特殊权限", href: "/admin/roles", permission: "role.view" }] },
  BOOKING: {
    code: "BOOKING",
    title: "订舱人员门户",
    description: "处理运输资源预订、承运商协同、发运资料和运单。",
    viewAreas: ["本人负责订单", "承运商与运输安排", "订舱和运单", "发运文件"],
    operateAreas: ["录入运输与订舱安排", "维护运单", "协助配载", "核对发运文件"],
    moduleCodes: ["transport", "loading", "documents"],
    quickLinks: [
      { label: "运输待办", description: "处理分配任务", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "运输单据", description: "维护运输运单", href: "/admin/shipments", permission: "shipment.view" },
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
    title: "任务工作台",
    description: "查看分配给本账号的订单和下一步待办。",
    viewAreas: ["本人负责订单", "本人待办"],
    operateAreas: ["按已授权模块办理业务"],
    moduleCodes: allModules,
    quickLinks: [
      { label: "我的待办", description: "查看分配给我的任务", href: "/admin/workbenches/tasks", permission: "order.view" },
      { label: "订单中心", description: "查看订单", href: "/admin/orders", permission: "order.view" },
    ],
  };
}

export function visiblePortalLinks(config: PositionPortalConfig, permissions: string[]) {
  return config.quickLinks.filter(
    (link) =>
      (!link.permission || permissions.includes(link.permission)) &&
      (link.href !== "/admin/billing" || canAccessSettlementWorkbench(permissions)),
  );
}

export function moduleManagePermission(moduleCode: string) {
  return `order.module.${moduleCode}.manage`;
}

export function canManageOrderModule(user: PortalUser, moduleCode: string) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => code === "owner" || code === "boss" || code === "developer") ||
    user.permissions.includes(moduleManagePermission(moduleCode))
  );
}

export const positionPortalConfigs = Object.values(portalConfigs);
