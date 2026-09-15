import { describe, expect, it } from "vitest";
import { connectionStatusLabel, hasActiveInteraction } from "./interaction-state";

describe("interaction state", () => {
  it("treats route and fetcher requests as one global activity signal", () => {
    expect(hasActiveInteraction("idle", ["idle"])).toBe(false);
    expect(hasActiveInteraction("loading", ["idle"])).toBe(true);
    expect(hasActiveInteraction("idle", ["submitting"])).toBe(true);
  });

  it("never describes an offline page as synchronized", () => {
    expect(connectionStatusLabel({
      online: false,
      syncing: false,
    })).toBe("离线，当前数据可能已过期");
  });

  it("distinguishes active synchronization from an idle healthy connection", () => {
    expect(connectionStatusLabel({ online: true, syncing: true }))
      .toBe("正在同步页面数据…");
    expect(connectionStatusLabel({ online: true, syncing: false }))
      .toBe("网络在线");
  });
});
