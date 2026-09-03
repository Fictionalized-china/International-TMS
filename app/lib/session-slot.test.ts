import { describe, expect, it } from "vitest";
import {
  normalizeSessionSlot,
  sessionCookieName,
  sessionSlotFromRequest,
  sessionSlotFromUrl,
  withSessionSlot,
} from "./session-slot";

const slotA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const slotB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const slotC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("tab-scoped staff sessions", () => {
  it("accepts only bounded opaque slot identifiers", () => {
    expect(normalizeSessionSlot(slotA)).toBe(slotA);
    expect(normalizeSessionSlot("short")).toBeNull();
    expect(normalizeSessionSlot("../../cookie-name-injection")).toBeNull();
  });

  it("uses URL, then request header, then same-tab referrer", () => {
    expect(sessionSlotFromRequest(new Request(`https://admin.example.test/admin?itmsTab=${slotA}`, {
      headers: { "X-ITMS-Tab": slotB, Referer: `https://admin.example.test/admin?itmsTab=${slotC}` },
    }))).toBe(slotA);
    expect(sessionSlotFromRequest(new Request("https://admin.example.test/admin", {
      headers: { "X-ITMS-Tab": slotB, Referer: `https://admin.example.test/admin?itmsTab=${slotC}` },
    }))).toBe(slotB);
    expect(sessionSlotFromRequest(new Request("https://admin.example.test/admin", {
      headers: { Referer: `https://admin.example.test/admin?itmsTab=${slotC}` },
    }))).toBe(slotC);
  });

  it("keeps the slot on redirects without dropping existing query parameters", () => {
    expect(withSessionSlot("/warehouse?warehouseId=wh-1", slotA))
      .toBe(`/warehouse?warehouseId=wh-1&itmsTab=${slotA}`);
    expect(sessionSlotFromUrl(withSessionSlot("/admin", slotB))).toBe(slotB);
    expect(withSessionSlot("/admin/orders#today", slotB)).toBe(`/admin/orders?itmsTab=${slotB}#today`);
  });

  it("gives each tab and warehouse an independent cookie name", () => {
    expect(sessionCookieName("admin", null, slotA)).toBe(`itms_admin_session_${slotA}`);
    expect(sessionCookieName("admin", null, slotB)).toBe(`itms_admin_session_${slotB}`);
    expect(sessionCookieName("warehouse", "wh/1", slotA)).toBe(`itms_warehouse_session_wh1_${slotA}`);
    expect(sessionCookieName("admin", null, null)).toBeNull();
  });
});
