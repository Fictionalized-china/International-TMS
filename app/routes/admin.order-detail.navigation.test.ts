import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));

import * as orderDetailRoute from "./admin.order-detail";

type OrderDetailNavigationExports = {
  ordinaryOrderListHref?: () => string;
};

const navigationExports = orderDetailRoute as typeof orderDetailRoute & OrderDetailNavigationExports;

describe("ordinary order detail navigation", () => {
  it("returns explicitly to the ordinary-order tab", () => {
    expect(navigationExports.ordinaryOrderListHref).toBeTypeOf("function");
    expect(navigationExports.ordinaryOrderListHref?.()).toBe("/admin/orders?view=orders");
  });
});
