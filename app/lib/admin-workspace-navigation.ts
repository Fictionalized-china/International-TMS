import {
  adminNavigationPermissionGroups,
  canViewAdminNavigationItem,
  type AdminNavigationGroupKey,
  type AdminNavigationItemKey,
  type AdminNavigationUser,
} from "./admin-navigation";
import { sessionSlotFromUrl, withSessionSlot } from "./session-slot";

export type AdminWorkspaceKey = "portal" | "trackingCenter" | "orders" | "billing" | "sales";
export type AdminWorkspaceSection = {
  key: AdminNavigationItemKey | "vehicles" | "directIntake" | "batchTracking";
  label: string;
  href: string;
};
export type AdminPrimaryNavigationItem = {
  key: AdminNavigationItemKey;
  label: string;
  href: string;
};

const absorbedKeys = new Set<AdminNavigationItemKey>(["dashboard", "shipments", "settlementApprovals", "cargo", "quotations"]);
const workspaceLabels: Record<AdminWorkspaceKey, string> = {
  portal: "工作台", trackingCenter: "调度与运踪", orders: "订单中心", billing: "费用结算", sales: "销售管理",
};
function isWorkspace(key: AdminNavigationItemKey): key is AdminWorkspaceKey {
  return Object.prototype.hasOwnProperty.call(workspaceLabels, key);
}

/** Only combine entrances, never union the business permissions of their children. */
export function adminWorkspaceSections(user: AdminNavigationUser, workspace: AdminWorkspaceKey): AdminWorkspaceSection[] {
  const can = (key: AdminNavigationItemKey) => canViewAdminNavigationItem(user, key);
  const sections: (AdminWorkspaceSection | false)[] = workspace === "portal" ? [
    can("portal") && { key: "portal", label: "我的待办", href: "/admin/portal" },
    can("dashboard") && { key: "dashboard", label: "运营看板", href: "/admin" },
  ] : workspace === "trackingCenter" ? [
    can("trackingCenter") && { key: "trackingCenter", label: "调度与运踪总览", href: "/admin/tracking-center" },
    can("trackingCenter") && user.permissions.includes("order.view") && user.permissions.includes("transport.batch.assigned.view") &&
      { key: "batchTracking", label: "配载单运踪", href: "/admin/loading?view=tracking" },
    can("shipments") && { key: "shipments", label: "运单档案", href: "/admin/shipments" },
    (can("trackingCenter") || can("shipments")) && { key: "vehicles", label: "在途车辆", href: "/admin/domestic-tracking" },
  ] : workspace === "orders" ? [
    can("orders") && { key: "orders", label: "订单台账", href: "/admin/orders" },
    can("cargo") && { key: "cargo", label: "货物检索", href: "/admin/cargo" },
    user.permissions.includes("menu.admin.orders.view") && user.permissions.includes("order.intake.manage") &&
      { key: "directIntake", label: "直接录单", href: "/admin/quotations?entryMode=direct" },
  ] : workspace === "billing" ? [
    can("settlementApprovals") && { key: "settlementApprovals", label: "待我审批", href: "/admin/settlement-approvals" },
    can("billing") && { key: "billing", label: "对账与收付款", href: "/admin/billing" },
  ] : [
    can("sales") && { key: "sales", label: "线索与商机", href: "/admin/sales" },
    can("quotations") && { key: "quotations", label: "报价辅助", href: "/admin/quotations" },
  ];
  return sections.filter((section): section is AdminWorkspaceSection => Boolean(section));
}

export function adminWorkspaceDefaultHref(user: AdminNavigationUser, workspace: AdminWorkspaceKey) {
  const sections = adminWorkspaceSections(user, workspace);
  const manager = ["BOSS", "OPERATION_SUPERVISOR"].includes(user.positionCode ?? "") ||
    user.roleCodes.some(code => ["owner", "boss", "developer"].includes(code));
  const preferred = workspace === "portal" && manager ? "dashboard" : workspace;
  return sections.find(section => section.key === preferred)?.href ?? sections[0]?.href ?? null;
}

/** Retain the legacy permission catalogue; only the visible sidebar is consolidated. */
export function adminPrimaryNavigationGroups(user: AdminNavigationUser) {
  return adminNavigationPermissionGroups.map(group => {
    const items: AdminPrimaryNavigationItem[] = [];
    for (const item of group.items) {
      if (absorbedKeys.has(item.key)) continue;
      const href = isWorkspace(item.key) ? adminWorkspaceDefaultHref(user, item.key) :
        canViewAdminNavigationItem(user, item.key) ? item.href : null;
      if (!href) continue;
      const organizationHref = item.key === "organizationAccess" ?
        user.permissions.includes("department.view") ? "/admin/departments" :
          user.permissions.includes("user.view") ? "/admin/positions" : "/admin/roles" : href;
      items.push({ key: item.key, label: isWorkspace(item.key) ? workspaceLabels[item.key] : item.label, href: organizationHref });
    }
    return { key: group.key as AdminNavigationGroupKey, label: group.label, items };
  }).filter(group => group.items.length > 0);
}

function within(pathname: string, root: string) {
  return pathname === root || pathname.startsWith(`${root}/`);
}
// React Router accepts case-insensitive paths and trailing slashes by default.
function canonicalPath(pathname: string) {
  return pathname.replace(/\/+$/, "").toLowerCase();
}
function directIntake(pathname: string, search: string) {
  return pathname === "/admin/quotations" && new URLSearchParams(search).get("entryMode") === "direct";
}

export function adminWorkspaceSectionActive(section: AdminWorkspaceSection, pathname: string, search = "") {
  pathname = canonicalPath(pathname);
  if (section.key === "batchTracking") return within(pathname, "/admin/loading");
  if (section.key === "dashboard") return pathname === "/admin" || pathname === "/admin/";
  if (section.key === "directIntake") return directIntake(pathname, search);
  if (section.key === "quotations") return within(pathname, "/admin/quotations") && !directIntake(pathname, search);
  return within(pathname, section.href);
}

export function adminPrimaryNavigationItemActive(item: AdminPrimaryNavigationItem, pathname: string, search = "") {
  pathname = canonicalPath(pathname);
  if (item.key === "portal") return pathname === "/admin" || pathname === "/admin/" || within(pathname, "/admin/portal");
  if (item.key === "trackingCenter") return ["/admin/tracking-center", "/admin/shipments", "/admin/domestic-tracking", "/admin/workbenches/tracking"].some(root => within(pathname, root));
  if (item.key === "orders") return within(pathname, "/admin/orders") || within(pathname, "/admin/cargo") || directIntake(pathname, search);
  if (item.key === "billing") return within(pathname, "/admin/billing") || within(pathname, "/admin/settlement-approvals");
  if (item.key === "sales") return within(pathname, "/admin/sales") || (within(pathname, "/admin/quotations") && !directIntake(pathname, search));
  if (item.key === "organizationAccess") return ["/admin/departments", "/admin/positions", "/admin/users", "/admin/roles"].some(root => within(pathname, root));
  if (item.key === "workflow") return within(pathname, "/admin/workflow") || within(pathname, "/admin/process-policy");
  return within(pathname, item.href);
}

/** Carry only the valid tab identity; a parent's page/tab/filter is not a child's filter. */
export function adminWorkspaceHref(href: string, currentSearch: string) {
  return withSessionSlot(href, sessionSlotFromUrl(`/${currentSearch}`));
}
