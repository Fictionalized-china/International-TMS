import { describe, expect, it } from "vitest";
import { siteFromRequest, siteHome, siteHomeFromRequest, siteLogin } from "./site.server";

describe("site routing", () => {
  it("routes the customer subdomain to the portal", () => {
    expect(siteFromRequest(new Request("https://portal.oulingtruck.com/"))).toBe("portal");
    expect(siteFromRequest(new Request("https://portal.shxlh.com/"))).toBe("portal");
    expect(siteHome("portal")).toBe("/portal");
    expect(siteLogin("portal")).toBe("/portal/login");
  });

  it("routes the tracking subdomain to the customer tracking entry", () => {
    expect(siteFromRequest(new Request("https://track.shxlh.com/"))).toBe("portal");
    expect(siteHomeFromRequest(new Request("https://track.shxlh.com/"))).toBe("/portal/tracking");
  });

  it("routes other hosts to the operations site", () => {
    expect(siteFromRequest(new Request("https://admin.oulingtruck.com/"))).toBe("admin");
    expect(siteFromRequest(new Request("https://tms.shxlh.com/"))).toBe("admin");
    expect(siteHomeFromRequest(new Request("https://tms.shxlh.com/"))).toBe("/admin/portal");
    expect(siteFromRequest(new Request("https://international-tms.example.workers.dev/"))).toBe("admin");
  });

  it("routes the warehouse subdomain and local path to the warehouse site", () => {
    expect(siteFromRequest(new Request("https://warehouse.oulingtruck.com/"))).toBe("warehouse");
    expect(siteFromRequest(new Request("https://warehouse.shxlh.com/"))).toBe("warehouse");
    expect(siteFromRequest(new Request("http://127.0.0.1:5188/warehouse/login"))).toBe("warehouse");
    expect(siteHome("warehouse")).toBe("/warehouse");
    expect(siteLogin("warehouse")).toBe("/warehouse/login");
  });
});
