import { canAccessSettlementWorkbench } from "./billing-access";
import { canAccessBatchWorkspace, type OrderAccessUser } from "./order-access";

export type AdminNavigationGroupKey =
  | "workbench"
  | "transport"
  | "businessData"
  | "system";

export type AdminNavigationPermissionGroup = {
  key: AdminNavigationGroupKey;
  label: string;
  description: string;
  enablePermissionCodes: readonly string[];
  controllingPermissionCodes: readonly string[];
};

/**
 * 一级菜单只是现有权限的批量编辑入口，不是第二套授权体系。
 * 开启时写入能够展示该组全部菜单项的最小权限集合；关闭时移除所有
 * 可能令该组菜单可见的现有权限。路由和服务端仍以原权限为准。
 */
export const adminNavigationPermissionGroups: readonly AdminNavigationPermissionGroup[] = [
  {
    key: "workbench",
    label: "工作台",
    description: "任务工作台和通知固定可见；此开关控制运营总览。",
    enablePermissionCodes: ["dashboard.view"],
    controllingPermissionCodes: ["dashboard.view"],
  },
  {
    key: "transport",
    label: "汽运业务",
    description: "订单、配载、运单、文件、费用和货物业务入口。",
    enablePermissionCodes: [
      "quote.view",
      "order.view",
      "shipment.view",
      "transport.batch.assigned.view",
      "order.module.documents.manage",
      "billing.view",
      "billing.sensitive.view",
      "order.module.cargo.manage",
    ],
    controllingPermissionCodes: [
      "quote.view",
      "order.view",
      "shipment.view",
      "transport.batch.assigned.view",
      "transport.batch.approve",
      "order.module.loading.manage",
      "order.module.costs.manage",
      "order.module.documents.manage",
      "billing.view",
      "billing.sensitive.view",
      "order.module.cargo.manage",
    ],
  },
  {
    key: "businessData",
    label: "业务资料",
    description: "客户、销售、产品、承运商和业务工作流资料。",
    enablePermissionCodes: [
      "customer.view",
      "sales.view",
      "pricing.view",
      "carrier.view",
      "workflow.view",
    ],
    controllingPermissionCodes: [
      "customer.view",
      "sales.view",
      "pricing.view",
      "carrier.view",
      "workflow.view",
    ],
  },
  {
    key: "system",
    label: "系统",
    description: "基础数据、组织账号、角色安全和审计入口。",
    enablePermissionCodes: [
      "master.view",
      "warehouse.manage",
      "department.view",
      "user.view",
      "role.view",
      "security.manage",
      "audit.view",
    ],
    controllingPermissionCodes: [
      "master.view",
      "warehouse.manage",
      "department.view",
      "user.view",
      "role.view",
      "security.manage",
      "audit.view",
    ],
  },
] as const;

type AdminNavigationUser = Pick<
  OrderAccessUser,
  "positionCode" | "roleCodes" | "permissions"
>;

export function adminNavigationGroupVisibility(user: AdminNavigationUser) {
  const can = (permission: string) => user.permissions.includes(permission);

  return {
    workbench: true,
    transport:
      can("quote.view") ||
      can("order.view") ||
      can("shipment.view") ||
      canAccessBatchWorkspace(user) ||
      can("order.module.documents.manage") ||
      canAccessSettlementWorkbench(user.permissions) ||
      can("order.module.cargo.manage"),
    businessData:
      can("customer.view") ||
      can("sales.view") ||
      can("pricing.view") ||
      can("carrier.view") ||
      can("workflow.view"),
    system:
      can("master.view") ||
      can("warehouse.manage") ||
      can("department.view") ||
      can("user.view") ||
      can("role.view") ||
      can("security.manage") ||
      can("audit.view"),
  } satisfies Record<AdminNavigationGroupKey, boolean>;
}
