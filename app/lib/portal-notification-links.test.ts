import { describe, expect, it } from "vitest";
import {
  normalizePortalNotificationLink,
  portalOrderListLink,
} from "./portal-notification-links";

describe("portal notification links", () => {
  it("builds order links with the keyword filter used by the portal", () => {
    expect(portalOrderListLink("SO 2026/001"))
      .toBe("/portal/orders?keyword=SO%202026%2F001");
  });

  it("repairs legacy arrival-notification order links", () => {
    expect(normalizePortalNotificationLink("/portal/orders?order=SO2026082600138"))
      .toBe("/portal/orders?keyword=SO2026082600138");
  });

  it("repairs legacy quotation links to the unified order view", () => {
    expect(normalizePortalNotificationLink("/portal/quotes?status=pending&quote=quote-1"))
      .toBe("/portal/orders?status=quote_pending&quote=quote-1");
  });

  it("leaves unrelated and external links unchanged", () => {
    expect(normalizePortalNotificationLink("https://example.com/orders?order=1"))
      .toBe("https://example.com/orders?order=1");
  });
});
