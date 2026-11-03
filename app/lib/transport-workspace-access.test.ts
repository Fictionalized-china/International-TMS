import { describe, expect, it } from "vitest";
import { adminPrimaryNavigationGroups } from "./admin-workspace-navigation";
import { canViewAdminNavigationItem, normalizeAdminNavigationPermissions } from "./admin-navigation";
import { accessModelRolePermissions } from "./access-model-seed.server";
import { canViewOrderWorkbench, canViewTrackingCenter, orderTaskWorkspaceHref } from "./transport-workspace-access";
import { internalNotificationObjectHref } from "./internal-notification-links";
import { readFileSync } from "node:fs";
import { adminNavigationPermissionItems } from "./admin-navigation";
import { adminWorkspaceSections } from "./admin-workspace-navigation";
import { positionPortalConfigs, visiblePortalLinks } from "./position-portal";

describe("independent transport workspaces", () => {
  it("resolves every primary, secondary and position-portal entrance to a registered route", () => {
    const routeSource = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
    const routes = [...routeSource.matchAll(/\broute\(\s*"([^"]+)"/g)].map(match =>
      new RegExp(`^/${match[1].split("/").map(part => part.startsWith(":") ? "[^/]+" : part).join("/")}/?$`));
    const permissions = normalizeAdminNavigationPermissions([
      ...new Set(Object.values(accessModelRolePermissions).flat()),
      ...adminNavigationPermissionItems.map(item => item.menuPermissionCode),
    ]);
    for (const config of positionPortalConfigs) {
      const actor = { positionCode: config.code, roleCodes: [], permissions };
      const primary = adminPrimaryNavigationGroups(actor).flatMap(group => group.items);
      const workspaces = ["portal", "trackingCenter", "orders", "billing", "sales"] as const;
      const entrances = [...primary, ...workspaces.flatMap(key => adminWorkspaceSections(actor, key)), ...visiblePortalLinks(config, permissions)];
      for (const entrance of entrances) {
        const path = new URL(entrance.href, "https://tms.invalid").pathname;
        expect(routes.some(route => route.test(path)), `${config.code}: ${entrance.label} ${path}`).toBe(true);
      }
    }
  });
  it("does not convert operation shipment access into overseas tracking access", () => {
    const operation = { positionCode: "OPERATION", roleCodes: ["pos_operation"], permissions: [...accessModelRolePermissions.pos_operation, "menu.admin.shipments.view", "menu.admin.tracking_center.view"] };
    expect(canViewTrackingCenter(operation)).toBe(false);
    expect(canViewAdminNavigationItem(operation, "trackingCenter")).toBe(false);
    expect(adminPrimaryNavigationGroups(operation).flatMap(group => group.items).filter(item => item.label === "调度与运踪")).toEqual([]);
    expect(adminPrimaryNavigationGroups(operation).flatMap(group => group.items)).toContainEqual(expect.objectContaining({ label: "运输执行", href: "/admin/shipments" }));
  });
  it("exposes a configurable primary dispatch menu alongside orders for commercial staff", () => {
    const commercial = { positionCode: "BUSINESS_ROUTE", roleCodes: ["pos_business_route"], permissions: normalizeAdminNavigationPermissions([...accessModelRolePermissions.pos_business_route, "menu.admin.dispatch.view", "menu.admin.orders.view"]) };
    expect(canViewTrackingCenter(commercial)).toBe(false);
    const items = adminPrimaryNavigationGroups(commercial).flatMap(group => group.items);
    expect(items).toContainEqual({ key: "dispatch", label: "找车", href: "/admin/dispatch" });
    expect(items).toContainEqual({ key: "orders", label: "订单中心", href: "/admin/orders" });
    expect(canViewAdminNavigationItem({ ...commercial, permissions: commercial.permissions.filter(permission => permission !== "menu.admin.dispatch.view") }, "dispatch")).toBe(false);
    expect(canViewTrackingCenter({ permissions: normalizeAdminNavigationPermissions(["menu.admin.tracking_center.view"]) })).toBe(true);
  });
  it("requires financial authorization for monetary workbench reads and writes", () => {
    expect(canViewOrderWorkbench({ permissions: ["order.view", "order.manage"] }, "costs")).toBe(false);
    expect(canViewOrderWorkbench({ permissions: ["order.view", "billing.view"] }, "costs")).toBe(false);
    expect(canViewOrderWorkbench({ permissions: ["order.view", "billing.view", "billing.sensitive.view"] }, "costs")).toBe(true);
    expect(canViewOrderWorkbench({ permissions: ["order.view", "shipment.view"] }, "tracking")).toBe(false);
  });
  it("repairs historical dispatch notifications without changing supervisor batch links", () => {
    for (const link of ["/admin/tracking-center", "/admin/tracking-center?dispatchTask=pending", "/admin/workbenches/dispatch"]) {
      expect(internalNotificationObjectHref({ category: "dispatch_request", link })).toBe("/admin/dispatch");
    }
    expect(internalNotificationObjectHref({ category: "dispatch_request", link: "/admin/loading/batch-1" })).toBe("/admin/loading/batch-1");
    expect(internalNotificationObjectHref({ category: "dispatch_request", link: "/admin/orders/order-1/modules/dispatch" })).toBe("/admin/dispatch?orderId=order-1");
    expect(internalNotificationObjectHref({ category: "dispatch_request", link: "/admin/orders/%ZZ/modules/dispatch" })).toBe("/admin/dispatch");
    expect(internalNotificationObjectHref({ category: "dispatch_ready", link: "/admin/tracking-center" })).toBe("/admin/orders");
    expect(internalNotificationObjectHref({ category: "dispatch_request", link: "//external.test" })).toBeNull();
    expect(orderTaskWorkspaceHref("order-1", "dispatch")).toBe("/admin/dispatch?orderId=order-1");
    expect(orderTaskWorkspaceHref("order-1", "transport")).toBe("/admin/orders/order-1/modules/transport");
  });
});
