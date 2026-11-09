import { describe, expect, it } from "vitest";

import * as liveDataRefresh from "./live-data-refresh";
import {
  canRequestLiveDataRefresh,
  createLiveDataSignalReceiver,
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
  it.each(["submitting", "loading"] as const)("waits for a %s fetcher, not only the page navigation", state => {
    expect(canRequestLiveDataRefresh({ visibilityState: "visible", navigationState: "idle", revalidationState: "idle", fetcherStates: ["idle", state] })).toBe(false);
    expect(canRequestLiveDataRefresh({ visibilityState: "visible", navigationState: "idle", revalidationState: "idle", fetcherStates: ["idle", "idle"] })).toBe(true);
  });
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

describe("createLiveDataSignalReceiver", () => {
  it("accepts one notification delivered via both broadcast and storage only once", () => {
    const receive = createLiveDataSignalReceiver("this-app");
    const signal = { senderId: "other-app", signalId: "mutation-one" };
    expect(receive(signal)).toBe(true);
    expect(receive(JSON.stringify(signal))).toBe(false);
    expect(receive({ ...signal, signalId: "mutation-two" })).toBe(true);
    expect(receive({ ...signal, senderId: "third-app" })).toBe(true);
    expect(receive({ ...signal, senderId: "this-app" })).toBe(false);
  });
  it("does not confuse different notifications at the same clock time", () => {
    const receive = createLiveDataSignalReceiver("this-app");
    expect(receive({ senderId: "other", signalId: "first", occurredAt: 1 })).toBe(true);
    expect(receive({ senderId: "other", signalId: "second", occurredAt: 1 })).toBe(true);
  });
  it.each([null, "not-json", {}, { senderId: "other", occurredAt: 1 }, { signalId: "missing-sender" }, { senderId: "other", signalId: "x".repeat(129) }])("keeps unrecognized/legacy hint %j conservative", signal => {
    const receive = createLiveDataSignalReceiver("this-app");
    expect(receive(signal)).toBe(true);
    expect(receive(signal)).toBe(true);
  });
  it("bounds memory and never shares notification history across App instances", () => {
    const receive = createLiveDataSignalReceiver("this-app");
    const signal = { senderId: "other", signalId: "first" };
    expect(receive(signal)).toBe(true);
    for (let index = 0; index < 64; index++) expect(receive({ ...signal, signalId: `later-${index}` })).toBe(true);
    expect(receive(signal)).toBe(true);
    expect(createLiveDataSignalReceiver("this-app")(signal)).toBe(true);
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
