import { describe, expect, it } from "vitest";

import * as liveDataRefresh from "./live-data-refresh";
import {
  canRequestLiveDataRefresh,
  isLiveDataRoute,
} from "./live-data-refresh";

type LiveDataRefreshTestExports = {
  shouldRefreshForDataMutationSignal?: (
    signal: unknown,
    currentSenderId: string,
  ) => boolean;
};

const testExports = liveDataRefresh as typeof liveDataRefresh & LiveDataRefreshTestExports;

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

describe("shouldRefreshForDataMutationSignal", () => {
  it("ignores a signal emitted by the same App instance", () => {
    expect(testExports.shouldRefreshForDataMutationSignal).toBeTypeOf("function");

    expect(testExports.shouldRefreshForDataMutationSignal?.(
      JSON.stringify({ sessionSlot: "shared-slot-001", senderId: "app-instance-001" }),
      "app-instance-001",
    )).toBe(false);
  });

  it("refreshes for another App instance even when a copied tab shares the same session slot", () => {
    expect(testExports.shouldRefreshForDataMutationSignal).toBeTypeOf("function");

    expect(testExports.shouldRefreshForDataMutationSignal?.(
      JSON.stringify({ sessionSlot: "shared-slot-001", senderId: "app-instance-002" }),
      "app-instance-001",
    )).toBe(true);
  });

  it("refreshes for a legacy signal without a sender id", () => {
    expect(testExports.shouldRefreshForDataMutationSignal).toBeTypeOf("function");

    expect(testExports.shouldRefreshForDataMutationSignal?.(
      JSON.stringify({ sessionSlot: "shared-slot-001", occurredAt: 1 }),
      "app-instance-001",
    )).toBe(true);
  });
});
