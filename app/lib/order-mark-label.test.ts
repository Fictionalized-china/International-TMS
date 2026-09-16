import { describe, expect, it } from "vitest";
import { buildOrderMarkLabelSvg, orderMarkLabelFacts, type OrderMarkLabel } from "./order-mark-label";
import { orderMarkLabelAvailable } from "./order-mark-label-policy";

describe("order mark label", () => {
  it("becomes available as soon as the quote is accepted while the order is still draft", () => {
    expect(orderMarkLabelAvailable({
      status: "draft",
      acceptedAt: "2026-09-01T12:00:00.000Z",
    })).toBe(true);
    expect(orderMarkLabelAvailable({ status: "draft", acceptedAt: null })).toBe(false);
  });

  it("blocks withdrawn and cancelled labels from operational printing", () => {
    expect(orderMarkLabelAvailable({
      status: "draft",
      acceptedAt: "2026-09-01T12:00:00.000Z",
      quoteWithdrawn: 1,
    })).toBe(false);
    expect(orderMarkLabelAvailable({
      status: "cancelled",
      acceptedAt: "2026-09-01T12:00:00.000Z",
    })).toBe(false);
  });

  it("keeps zero measurements visible instead of rendering an empty value", () => {
    expect(orderMarkLabelFacts({
      destination_country: "UZ",
      destination_state: null,
      destination_city: "Tashkent",
      overseas_warehouse_name: null,
      pieces: 0,
      declared_quantity_unit: "pcs",
      volume_cbm: 0,
      gross_weight_kg: 0,
      contact_phone: null,
      mark_contacts: [],
    })).toMatchObject({
      pieces: "0 pcs",
      volume: "0 CBM",
      weight: "0 KG",
    });
  });

  it("prints the order number as the mark number while retaining a package-specific scan code", () => {
    const order: OrderMarkLabel = {
      id: "order-1",
      order_number: "SO2026091500001",
      contact_phone: "+86 13800000000",
      mark_contacts: [{ id:"contact-1",name:"张三",type:"business",phone:"+86 13800000000" }],
      customer_name: "测试客户",
      cargo_description: "测试货物",
      pieces: 24,
      declared_quantity_unit: "件",
      planned_inbound_package_count: 2,
      planned_inbound_package_type: "纸箱",
      gross_weight_kg: 120.5,
      volume_cbm: 1.25,
      origin_country: "中国",
      origin_state: "广东省",
      origin_city: "深圳市",
      destination_country: "乌兹别克斯坦",
      destination_state: null,
      destination_city: "塔什干市",
      overseas_warehouse_name: "塔什干目的仓",
      status: "confirmed",
      label_generated_at: "2026-09-15T08:00:00.000Z",
      inbound_package_locked_at: null,
      marks: [{ id: "mark-1", code: "SO2026091500001-IN-001", sequence: 1, revision: 1 }],
    };

    expect(orderMarkLabelFacts(order)).toEqual({
      destination: "乌兹别克斯坦 塔什干市 · 塔什干目的仓",
      pieces: "24 件",
      volume: "1.25 CBM",
      weight: "120.5 KG",
      phone: "业务联系：张三 +86 13800000000",
      contacts: [{ id:"contact-1",name:"张三",type:"business",phone:"+86 13800000000",label:"业务联系" }],
    });
    const svg = buildOrderMarkLabelSvg(order);
    expect(svg).toContain("唛头号　SO2026091500001");
    expect(svg).toContain("扫描码：SO2026091500001-IN-001");
    expect(svg).toContain("目的地");
    expect(svg).toContain("我方联系人");
    expect(svg).toContain("业务联系：张三 +86 13800000000");
    expect(svg).not.toContain("运输线路");
    expect(svg).not.toContain("客户</text>");
  });

});
