import { describe, expect, it } from "vitest";

import {
  canRequestLiveDataRefresh,
  isLiveDataRoute,
} from "./live-data-refresh";

describe("isLiveDataRoute", () => {
  it.each([
    "/admin/portal",
    "/admin/quotations",
    "/admin/orders",
    "/admin/orders/order-1",
    "/admin/loading/batch-1",
    "/admin/billing",
    "/admin/workbenches/tasks",
    "/admin/domestic-tracking",
    "/admin/documents",
    "/admin/cargo",
    "/warehouse",
    "/warehouse/inbound",
    "/portal",
    "/portal/orders/order-1",
  ])("enables cross-account refresh for %s", (pathname) => {
    expect(isLiveDataRoute(pathname)).toBe(true);
  });

  it.each([
    "/login",
    "/admin/workflows",
    "/admin/users",
    "/warehouse/login",
    "/portal/login",
    "/portal/register",
  ])("does not poll non-operational or authentication route %s", (pathname) => {
    expect(isLiveDataRoute(pathname)).toBe(false);
  });
});

describe("canRequestLiveDataRefresh", () => {
  it("refreshes only while the page and both routers are idle", () => {
    expect(canRequestLiveDataRefresh({
      visibilityState: "visible",
      navigationState: "idle",
      revalidationState: "idle",
    })).toBe(true);
    expect(canRequestLiveDataRefresh({
      visibilityState: "hidden",
      navigationState: "idle",
      revalidationState: "idle",
    })).toBe(false);
    expect(canRequestLiveDataRefresh({
      visibilityState: "visible",
      navigationState: "submitting",
      revalidationState: "idle",
    })).toBe(false);
    expect(canRequestLiveDataRefresh({
      visibilityState: "visible",
      navigationState: "idle",
      revalidationState: "loading",
    })).toBe(false);
  });
});
