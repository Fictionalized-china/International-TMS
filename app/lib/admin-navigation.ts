import { canAccessBatchWorkspace, type OrderAccessUser } from "./order-access";

export type AdminNavigationGroupKey =
  | "workbench"
  | "control"
  | "transport"
  | "businessData"
  | "system";

export type AdminNavigationItemKey =
  | "portal"
  | "notifications"
  | "dashboard"
  | "trackingCenter"
  | "analytics"
  | "quotations"
  | "orders"
  | "loading"
  | "documents"
  | "shipments"
  | "billing"
  | "cargo"
  | "customers"
  | "sales"
  | "logisticsProducts"
  | "carriers"
  | "workflow"
  | "masterData"
  | "warehouses"
  | "organizationAccess"
  | "security"
  | "audit";

type AdminNavigationUser = Pick<
  OrderAccessUser,
  "positionCode" | "roleCodes" | "permissions"
>;

export type AdminNavigationPermissionItem = {
  key: AdminNavigationItemKey;
  label: string;
  description: string;
  href: string;
  menuPermissionCode: string;
  /** 打开菜单时自动补足的最小页面读取权限，不包含任何写权限。 */
  enablePermissionCodes: readonly string[];
  accessPermissionCodes: readonly string[];
  accessMode?: "all" | "any";
  accessKind?: "permissions" | "batchWorkspace";
};

export type AdminNavigationPermissionGroup = {
  key: AdminNavigationGroupKey;
  label: string;
  description: string;
  items: readonly AdminNavigationPermissionItem[];
};

/**
 * 管理端菜单权限只控制入口可见性；页面读取、编辑、审批和删除继续由既有
 * 业务权限控制。启用菜单时仅补足进入该页面所需的最小读取权限。
 */
export const adminNavigationPermissionGroups: readonly AdminNavigationPermissionGroup[] = [
  {
    key: "workbench",
    label: "工作台",
    description: "个人任务、通知和运营概览。",
    items: [
      navigationItem("portal", "任务工作台", "查看本人待办与工作入口。", "/admin/portal", []),
      navigationItem("notifications", "通知", "查看站内通知。", "/admin/notifications", []),
      navigationItem("dashboard", "运营总览", "查看岗位范围内的运营概览。", "/admin", ["dashboard.view"]),
    ],
  },
  {
    key: "control",
    label: "运营控制",
    description: "集中查看调度、运踪、时效预警与经营分析。",
    items: [
      navigationItem("trackingCenter", "调度与运踪", "统一查看调度、在途轨迹和时效预警。", "/admin/tracking-center", ["shipment.view"]),
      navigationItem("analytics", "汇总分析", "按授权范围查看业务、仓库和财务汇总。", "/admin/analytics", ["analytics.business.view"]),
    ],
  },
  {
    key: "transport",
    label: "汽运业务",
    description: "订单、配载、单据、文件、费用与货物。",
    items: [
      navigationItem("quotations", "询价与报价", "查看客户询价和运输报价。", "/admin/quotations", ["quote.view"]),
      navigationItem("orders", "订单中心", "查看岗位范围内的运输订单。", "/admin/orders", ["order.view"]),
      {
        ...navigationItem("loading", "配载单跟踪", "查看本人可访问的配载单。", "/admin/loading", ["transport.batch.assigned.view"]),
        accessPermissionCodes: [
          "transport.batch.assigned.view",
          "transport.batch.approve",
          "order.module.loading.manage",
          "order.module.costs.manage",
        ],
        accessKind: "batchWorkspace",
      },
      navigationItem("documents", "文件中心", "查看订单与配载文件。", "/admin/documents", ["order.module.documents.view"], ["order.module.documents.view", "order.module.documents.manage"]),
      navigationItem("shipments", "运输单据", "查看运单与运输轨迹。", "/admin/shipments", ["shipment.view"]),
      navigationItem("billing", "费用结算", "查看获授权范围内的费用信息。", "/admin/billing", ["billing.view", "billing.sensitive.view"], undefined, "all"),
      navigationItem("cargo", "货物信息", "查看订单货物与包装信息。", "/admin/cargo", ["order.module.cargo.view"], ["order.module.cargo.view", "order.module.cargo.manage"]),
    ],
  },
  {
    key: "businessData",
    label: "业务资料",
    description: "客户、销售、产品、承运商和工作流资料。",
    items: [
      navigationItem("customers", "客户管理", "查看客户与客商资料。", "/admin/customers", ["customer.view"]),
      navigationItem("sales", "销售管理", "查看销售线索和商机。", "/admin/sales", ["sales.view"]),
      navigationItem("logisticsProducts", "物流产品", "查看产品和价格配置。", "/admin/logistics-products", ["pricing.view"]),
      navigationItem("carriers", "承运商管理", "查看承运商与运输资源。", "/admin/carriers", ["carrier.view"]),
      navigationItem("workflow", "业务工作流", "查看业务流程与字段规则。", "/admin/workflow", ["workflow.view"]),
    ],
  },
  {
    key: "system",
    label: "系统",
    description: "基础数据、仓库、组织、安全和审计。",
    items: [
      navigationItem("masterData", "基础数据", "查看系统基础字典。", "/admin/master-data", ["master.view"]),
      navigationItem("warehouses", "仓库管理", "查看管理端仓库清单与配置概况。", "/admin/warehouses", ["warehouse.admin.view"], ["warehouse.admin.view", "warehouse.manage"]),
      navigationItem("organizationAccess", "组织与权限", "查看部门、岗位、账号和权限。", "/admin/departments", ["department.view"], ["department.view", "user.view", "role.view"]),
      navigationItem("security", "安全中心", "查看登录会话和风险账号。", "/admin/security", ["security.view"], ["security.view", "security.manage"]),
      navigationItem("audit", "审计日志", "查看系统审计记录。", "/admin/audit", ["audit.view"]),
    ],
  },
] as const;

export const adminNavigationPermissionItems = adminNavigationPermissionGroups.flatMap(
  (group) => group.items,
);

function navigationItem(
  key: AdminNavigationItemKey,
  label: string,
  description: string,
  href: string,
  enablePermissionCodes: readonly string[],
  accessPermissionCodes: readonly string[] = enablePermissionCodes,
  accessMode: "all" | "any" = "any",
): AdminNavigationPermissionItem {
  return {
    key,
    label,
    description,
    href,
    menuPermissionCode: `menu.admin.${menuPermissionSegment(key)}.view`,
    enablePermissionCodes,
    accessPermissionCodes,
    accessMode,
    accessKind: "permissions",
  };
}

function menuPermissionSegment(key: AdminNavigationItemKey) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function hasItemPageAccess(user: AdminNavigationUser, item: AdminNavigationPermissionItem) {
  if (item.accessKind === "batchWorkspace") return canAccessBatchWorkspace(user);
  if (!item.accessPermissionCodes.length) return true;
  if (item.accessMode === "all") {
    return item.accessPermissionCodes.every((code) => user.permissions.includes(code));
  }
  return item.accessPermissionCodes.some((code) => user.permissions.includes(code));
}

export function canViewAdminNavigationItem(
  user: AdminNavigationUser,
  key: AdminNavigationItemKey,
) {
  const item = adminNavigationPermissionItems.find((candidate) => candidate.key === key);
  return Boolean(
    item &&
    user.permissions.includes(item.menuPermissionCode) &&
    hasItemPageAccess(user, item),
  );
}

export function adminNavigationItemVisibility(user: AdminNavigationUser) {
  return Object.fromEntries(adminNavigationPermissionItems.map((item) => [
    item.key,
    canViewAdminNavigationItem(user, item.key),
  ])) as Record<AdminNavigationItemKey, boolean>;
}

export function adminNavigationGroupVisibility(user: AdminNavigationUser) {
  const items = adminNavigationItemVisibility(user);
  return Object.fromEntries(adminNavigationPermissionGroups.map((group) => [
    group.key,
    group.items.some((item) => items[item.key]),
  ])) as Record<AdminNavigationGroupKey, boolean>;
}

/** 服务端保存角色权限时调用，防止菜单入口存在但最小读取权限缺失。 */
export function normalizeAdminNavigationPermissions(permissions: readonly string[]) {
  const normalized = new Set(permissions);
  for (const item of adminNavigationPermissionItems) {
    if (!normalized.has(item.menuPermissionCode)) continue;
    item.enablePermissionCodes.forEach((code) => normalized.add(code));
  }
  return [...normalized];
}

/** 新组织沿用旧角色能力时，为其补出等价的独立菜单入口。 */
export function inferAdminNavigationMenuPermissions(
  permissions: readonly string[],
  identity?: Pick<AdminNavigationUser, "positionCode" | "roleCodes">,
) {
  const user: AdminNavigationUser = {
    permissions: [...permissions],
    positionCode: identity?.positionCode ?? null,
    roleCodes: identity?.roleCodes ?? [],
  };
  return adminNavigationPermissionItems
    .filter((item) => hasItemPageAccess(user, item))
    .map((item) => item.menuPermissionCode);
}

export function canAccessWarehouseAdministration(permissions: readonly string[]) {
  return permissions.includes("warehouse.admin.view") || permissions.includes("warehouse.manage");
}
