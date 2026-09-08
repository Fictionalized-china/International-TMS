import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));

import * as orderDetailRoute from "./admin.order-detail";

type OrderDetailNavigationExports = {
  ordinaryOrderListHref?: () => string;
  canOperateScopedEmbeddedOrderModule?: (input: {
    moduleActionCanOperate?: boolean;
    moduleCanEdit?: boolean;
  }) => boolean;
  orderDetailActionPermission?: (intent: string, moduleCode?: string | null) => string;
};

const navigationExports = orderDetailRoute as typeof orderDetailRoute & OrderDetailNavigationExports;

describe("ordinary order detail navigation", () => {
  it("returns explicitly to the ordinary-order tab", () => {
    expect(navigationExports.ordinaryOrderListHref).toBeTypeOf("function");
    expect(navigationExports.ordinaryOrderListHref?.()).toBe("/admin/orders?view=orders");
  });

  it("lets an assigned embedded module owner operate without an order-level handoff", () => {
    const canOperate = navigationExports.canOperateScopedEmbeddedOrderModule;
    expect(canOperate).toBeTypeOf("function");
    expect(canOperate?.({ moduleActionCanOperate: true, moduleCanEdit: true })).toBe(true);
    expect(canOperate?.({ moduleActionCanOperate: false, moduleCanEdit: true })).toBe(false);
    expect(canOperate?.({ moduleActionCanOperate: true, moduleCanEdit: false })).toBe(false);
  });

  it("lets cargo mutations reach the frozen module gate without requiring broad order.manage", () => {
    const permission = navigationExports.orderDetailActionPermission;
    expect(permission).toBeTypeOf("function");
    expect(permission?.("cargo_create")).toBe("order.view");
    expect(permission?.("cargo_update")).toBe("order.view");
    expect(permission?.("order_update")).toBe("order.manage");
  });

  it("lets embedded document uploads reach their module and field gates", () => {
    const permission = navigationExports.orderDetailActionPermission;
    expect(permission?.("document_upload", "consignment")).toBe("order.view");
    expect(permission?.("document_upload", null)).toBe("order.manage");
  });
});
