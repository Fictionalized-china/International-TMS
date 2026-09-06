import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));

import * as orderDetailRoute from "./admin.order-detail";

type OrderDetailNavigationExports = {
  ordinaryOrderListHref?: () => string;
  canOperateScopedEmbeddedOrderModule?: (input: {
    moduleActionCanOperate?: boolean;
    moduleCanEdit?: boolean;
  }) => boolean;
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
});
