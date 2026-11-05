import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { BossWarehouseEntry, bossWarehouseHref } from "./BossWarehouseEntry";

const warehouses = [
  { id: "domestic", name: "国内仓", warehouse_role: "domestic_collection" },
  { id: "moscow", name: "莫斯科仓", warehouse_role: "overseas_destination" },
];
function render(positionCode: string, overseas = false) {
  const router = createMemoryRouter([{ path: "/", element: createElement(BossWarehouseEntry, {
    actor: { positionCode, roleCodes: [] }, warehouses, orderId: "order-1", overseas,
    actionUrl: "/admin/orders/order-1?itmsTab=test-boss-tab-01",
  }) }]);
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
describe("boss physical-operation entrance", () => {
  it("shows a real site-switch form with order, target warehouse and tab preserved", () => {
    const html = render("BOSS");
    expect(html).toContain('action="/switch-site?itmsTab=test-boss-tab-01"');
    expect(html).toContain('name="target" value="warehouse"');
    expect(html).toContain("以老板身份进入办理");
    expect(html).toContain("/warehouse/acceptance?warehouseId=domestic&amp;orderId=order-1");
    expect(html).not.toContain("warehouseId=moscow");
    expect(render("BOSS", true)).toContain("/warehouse/inbound?warehouseId=moscow&amp;orderId=order-1");
    expect(bossWarehouseHref(warehouses[0], "order-1", "outbound")).toBe("/warehouse/outbound?warehouseId=domestic&orderId=order-1");
  });
  it.each(["WAREHOUSE", "OVERSEAS_WAREHOUSE", "OPERATION", "CS", "DEVELOPER"])("does not expose a boss-only entry to %s", position => {
    expect(render(position)).toBe("");
  });
});
