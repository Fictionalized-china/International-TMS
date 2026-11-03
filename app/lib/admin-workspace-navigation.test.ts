import { describe, expect, it } from "vitest";
import { adminNavigationPermissionItems, normalizeAdminNavigationPermissions } from "./admin-navigation";
import {
  adminPrimaryNavigationGroups,
  adminPrimaryNavigationItemActive,
  adminWorkspaceSections,
  adminWorkspaceSectionActive,
  adminWorkspaceHref,
} from "./admin-workspace-navigation";

function user(permissions: string[], positionCode = "OPERATION") {
  return { permissions, positionCode, roleCodes: [] };
}

describe("consolidated admin navigation", () => {
  it("shows 19 primary entries but retains all 24 independently configurable permission records", () => {
    const full = user(normalizeAdminNavigationPermissions(adminNavigationPermissionItems.map(item => item.menuPermissionCode)));
    const items = adminPrimaryNavigationGroups(full).flatMap(group => group.items);
    expect(items).toHaveLength(19);
    expect(adminNavigationPermissionItems).toHaveLength(24);
    expect(items.map(item => item.key)).not.toEqual(expect.arrayContaining(["dashboard", "shipments", "cargo", "quotations", "settlementApprovals"]));
    expect(new Set(items.map(item => item.key)).size).toBe(19);
  });

  it("routes a signature-only account to approvals without granting financial amount visibility", () => {
    const actor = user(["order.view", "settlement.signature.manage", "menu.admin.settlement_approvals.view"]);
    const billing = adminPrimaryNavigationGroups(actor).flatMap(group => group.items).find(item => item.key === "billing");
    expect(billing?.href).toBe("/admin/settlement-approvals");
    expect(adminWorkspaceSections(actor, "billing").map(section => section.key)).toEqual(["settlementApprovals"]);
    expect(actor.permissions).not.toContain("billing.sensitive.view");
    expect(normalizeAdminNavigationPermissions(["menu.admin.settlement_approvals.view"])).not.toContain("billing.sensitive.view");
  });

  it.each([
    ["cargo", "order.module.cargo.view", "orders", "/admin/cargo"],
    ["shipments", "shipment.view", "trackingCenter", "/admin/shipments"],
    ["quotations", "quote.view", "sales", "/admin/quotations"],
  ] as const)("retains an accessible parent for %s-only accounts", (key, permission, parent, href) => {
    const item = adminNavigationPermissionItems.find(candidate => candidate.key === key)!;
    const groups = adminPrimaryNavigationGroups(user([item.menuPermissionCode, permission]));
    expect(groups.flatMap(group => group.items)).toEqual([expect.objectContaining({ key: parent, href })]);
  });

  it("defaults manager workbenches to the overview and ordinary workbenches to personal tasks", () => {
    const permissions = ["menu.admin.portal.view", "menu.admin.dashboard.view", "dashboard.view"];
    const href = (position: string) => adminPrimaryNavigationGroups(user(permissions, position))[0].items[0].href;
    expect(href("BOSS")).toBe("/admin");
    expect(href("OPERATION_SUPERVISOR")).toBe("/admin");
    expect(href("OPERATION")).toBe("/admin/portal");
    expect(adminPrimaryNavigationGroups(user(["menu.admin.dashboard.view", "dashboard.view"]))[0].items[0].href).toBe("/admin");
    expect(adminPrimaryNavigationGroups(user(["menu.admin.portal.view"], "BOSS"))[0].items[0].href).toBe("/admin/portal");
  });

  it("keeps menu switches effective and never mutates permission arrays", () => {
    const permissions = ["shipment.view", "quote.view", "billing.view", "billing.sensitive.view"];
    const snapshot = [...permissions];
    expect(adminPrimaryNavigationGroups(user(permissions))).toEqual([]);
    expect(permissions).toEqual(snapshot);
    expect(adminWorkspaceSections(user(["menu.admin.billing.view", "billing.view"]), "billing")).toEqual([]);
    expect(adminPrimaryNavigationGroups(user(["menu.admin.settlement_approvals.view", "settlement.signature.manage"]))).toEqual([]);
  });

  it("exposes direct intake only with its independent write permission, regardless of quotation permission", () => {
    const readOnly = user(["menu.admin.orders.view", "order.view"]);
    expect(adminWorkspaceSections(readOnly, "orders").map(section => section.key)).toEqual(["orders"]);
    expect(adminWorkspaceSections(user([...readOnly.permissions, "order.intake.manage"]), "orders").map(section => section.key)).toEqual(["orders", "directIntake"]);
    expect(adminWorkspaceSections(user(["menu.admin.quotations.view", "quote.view", "quote.manage"]), "sales").map(section => section.key)).toEqual(["quotations"]);
  });

  it("offers the tracking role a batch-level entrance only with batch read access", () => {
    const actor = user(["menu.admin.tracking_center.view", "shipment.view", "order.view", "transport.batch.assigned.view", "order.module.tracking.manage"], "TRACKING");
    const sections = adminWorkspaceSections(actor, "trackingCenter");
    expect(sections.map(section => section.key)).toContain("batchTracking");
    expect(sections.find(section => section.key === "batchTracking")?.href).toBe("/admin/loading?view=tracking");
    expect(adminWorkspaceSectionActive(sections.find(section => section.key === "batchTracking")!, "/admin/loading/batch-1", "?tab=tracking")).toBe(true);
    expect(adminWorkspaceSections(user(actor.permissions.filter(permission => permission !== "transport.batch.assigned.view"), "TRACKING"), "trackingCenter").map(section => section.key)).not.toContain("batchTracking");
  });

  it("matches path segment boundaries and gives direct intake and quotations different parents", () => {
    const items = adminPrimaryNavigationGroups(user(normalizeAdminNavigationPermissions(adminNavigationPermissionItems.map(item => item.menuPermissionCode)))).flatMap(group => group.items);
    const active = (path: string, search = "") => items.filter(item => adminPrimaryNavigationItemActive(item, path, search)).map(item => item.key);
    expect(active("/admin/orders/order-1/modules/cargo")).toEqual(["orders"]);
    expect(active("/admin/cargo")).toEqual(["orders"]);
    expect(active("/admin/shipments")).toEqual(["trackingCenter"]);
    expect(active("/admin/domestic-tracking")).toEqual(["trackingCenter"]);
    expect(active("/admin/settlement-approvals")).toEqual(["billing"]);
    expect(active("/admin/quotations", "?entryMode=direct")).toEqual(["orders"]);
    expect(active("/ADMIN/QUOTATIONS/", "?entryMode=direct")).toEqual(["orders"]);
    expect(active("/admin/quotations", "?entryMode=quote")).toEqual(["sales"]);
    expect(active("/admin/quotations", "?entryMode=directly")).toEqual(["sales"]);
    expect(active("/admin/orders-other")).toEqual([]);
    expect(active("/admin/tracking-center-other")).toEqual([]);
    expect(active("/admin")).toEqual(["portal"]);
  });

  it("marks exactly one order section active and does not confuse shared intake URL with quotation view", () => {
    const sections = adminWorkspaceSections(user(["menu.admin.orders.view", "order.view", "order.intake.manage", "menu.admin.cargo.view", "order.module.cargo.view"]), "orders");
    expect(sections.filter(section => adminWorkspaceSectionActive(section, "/admin/quotations", "?entryMode=direct")).map(section => section.key)).toEqual(["directIntake"]);
    expect(sections.filter(section => adminWorkspaceSectionActive(section, "/ADMIN/QUOTATIONS/", "?entryMode=direct")).map(section => section.key)).toEqual(["directIntake"]);
    expect(sections.filter(section => adminWorkspaceSectionActive(section, "/admin/orders/a")).map(section => section.key)).toEqual(["orders"]);
  });

  it("preserves a valid per-tab session without carrying incompatible workspace filters", () => {
    expect(adminWorkspaceHref("/admin/quotations?entryMode=direct", "?itmsTab=valid-session-123&q=ABC&tab=cash&page=3")).toBe("/admin/quotations?entryMode=direct&itmsTab=valid-session-123");
    expect(adminWorkspaceHref("/admin/cargo", "?itmsTab=invalid!")).toBe("/admin/cargo");
  });

  it("always selects an authorized child for every combination of independent menu and read grants", () => {
    const workspaces = ["portal", "trackingCenter", "orders", "billing", "sales"] as const;
    const grantsByWorkspace = [
      ["menu.admin.portal.view", "menu.admin.dashboard.view", "dashboard.view"],
      ["menu.admin.tracking_center.view", "menu.admin.shipments.view", "shipment.view"],
      ["menu.admin.orders.view", "menu.admin.cargo.view", "order.view", "order.module.cargo.view", "order.intake.manage"],
      ["menu.admin.billing.view", "menu.admin.settlement_approvals.view", "billing.view", "billing.sensitive.view", "order.view", "settlement.signature.manage"],
      ["menu.admin.sales.view", "menu.admin.quotations.view", "sales.view", "quote.view"],
    ];
    workspaces.forEach((workspace, index) => {
      const grants = grantsByWorkspace[index];
      for (let mask = 0; mask < 2 ** grants.length; mask++) {
        const actor = user(grants.filter((_, bit) => mask & (1 << bit)));
        const sections = adminWorkspaceSections(actor, workspace);
        const item = adminPrimaryNavigationGroups(actor).flatMap(group => group.items).find(candidate => candidate.key === workspace);
        expect(Boolean(item), `${workspace}:${mask}`).toBe(sections.length > 0);
        if (item) expect(sections.some(section => section.href === item.href), `${workspace}:${mask}`).toBe(true);
      }
    });
  });
});
