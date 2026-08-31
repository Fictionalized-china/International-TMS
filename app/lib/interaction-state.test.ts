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
      lastUpdatedAt: new Date("2026-09-01T02:00:00Z"),
    })).toBe("离线，当前数据可能已过期");
  });

  it("distinguishes initial, active and completed synchronization", () => {
    expect(connectionStatusLabel({ online: true, syncing: true, lastUpdatedAt: null }))
      .toBe("正在同步页面数据…");
    expect(connectionStatusLabel({ online: true, syncing: false, lastUpdatedAt: null }))
      .toBe("网络在线，等待首次同步");
    expect(connectionStatusLabel({
      online: true,
      syncing: false,
      lastUpdatedAt: new Date("2026-09-01T10:11:12+08:00"),
    })).toContain("页面已更新");
  });
});
