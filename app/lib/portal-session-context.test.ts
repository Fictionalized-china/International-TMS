import { describe, expect, it } from "vitest";
import {
  normalizePortalContextId,
  portalContextIdFromRequest,
  portalContextualPath,
  portalSessionCookieName,
  portalSessionTokenFromCookieHeader,
} from "./portal-session-context";

const WINDOW_ONE = "2b8fce90-4610-49de-938b-fec6b51fbdee";
const WINDOW_TWO = "e126bdd4-7d32-4e44-85ca-ec2b0bc25ae7";

describe("portal session window context", () => {
  it("selects a different HttpOnly session cookie for each browser window context", () => {
    const firstName = portalSessionCookieName(WINDOW_ONE);
    const secondName = portalSessionCookieName(WINDOW_TWO);
    const cookieHeader = `${firstName}=token-for-customer-1; ${secondName}=token-for-customer-2`;

    expect(firstName).not.toBe(secondName);
    expect(portalSessionTokenFromCookieHeader(cookieHeader, WINDOW_ONE)).toBe("token-for-customer-1");
    expect(portalSessionTokenFromCookieHeader(cookieHeader, WINDOW_TWO)).toBe("token-for-customer-2");
  });

  it("never falls back to another customer session when the context is absent or invalid", () => {
    const cookieHeader = `${portalSessionCookieName(WINDOW_ONE)}=customer-1`;

    expect(portalSessionTokenFromCookieHeader(cookieHeader, null)).toBeNull();
    expect(portalSessionTokenFromCookieHeader(cookieHeader, "../../admin")).toBeNull();
    expect(normalizePortalContextId("not-a-window-id")).toBeNull();
  });

  it("keeps the context through portal links, filters, downloads, and logout", () => {
    expect(portalContextualPath("/portal/orders?keyword=SO-1", WINDOW_ONE))
      .toBe(`/portal/orders?keyword=SO-1&portalContext=${WINDOW_ONE}`);
    expect(portalContextualPath("?tab=contacts", WINDOW_ONE, "/portal/account?tab=profile"))
      .toBe(`/portal/account?tab=contacts&portalContext=${WINDOW_ONE}`);
    expect(portalContextualPath("/logout?site=portal", WINDOW_ONE))
      .toBe(`/logout?site=portal&portalContext=${WINDOW_ONE}`);
  });

  it("reads only a validated context from the request URL", () => {
    expect(portalContextIdFromRequest(new Request(`https://portal.local/portal?portalContext=${WINDOW_TWO}`)))
      .toBe(WINDOW_TWO);
    expect(portalContextIdFromRequest(new Request("https://portal.local/portal?portalContext=bad")))
      .toBeNull();
  });
});
