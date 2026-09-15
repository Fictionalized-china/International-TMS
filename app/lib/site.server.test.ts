import { describe, expect, it } from "vitest";
import { siteFromRequest, siteHome, siteLogin } from "./site.server";

describe("site routing", () => {
  it("routes the customer subdomain to the portal", () => {
    expect(siteFromRequest(new Request("https://portal.oulingtruck.com/"))).toBe("portal");
    expect(siteHome("portal")).toBe("/portal");
    expect(siteLogin("portal")).toBe("/portal/login");
  });

  it("routes other hosts to the operations site", () => {
    expect(siteFromRequest(new Request("https://admin.oulingtruck.com/"))).toBe("admin");
    expect(siteFromRequest(new Request("https://international-tms.example.workers.dev/"))).toBe("admin");
  });

  it("routes the warehouse subdomain and local path to the warehouse site", () => {
    expect(siteFromRequest(new Request("https://warehouse.oulingtruck.com/"))).toBe("warehouse");
    expect(siteFromRequest(new Request("http://127.0.0.1:5188/warehouse/login"))).toBe("warehouse");
    expect(siteHome("warehouse")).toBe("/warehouse");
    expect(siteLogin("warehouse")).toBe("/warehouse/login");
  });
});
