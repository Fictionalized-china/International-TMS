import { describe, expect, it } from "vitest";
import {
  buildBatchOverseasInboundHref,
  parseBatchInboundOrderIds,
  resolveBatchInboundOrderFilter,
  resolveBatchOverseasInboundHandoff,
} from "./batch-overseas-inbound-navigation";

describe("PZ overseas inbound navigation", () => {
  const orders = [
    { order_id: "order-1", overseas_warehouse_id: "warehouse-1" },
    { order_id: "order-2", overseas_warehouse_id: "warehouse-1" },
    { order_id: "order-3", overseas_warehouse_id: "warehouse-1" },
  ];

  it("creates one destination-warehouse handoff for all mounted orders", () => {
    expect(resolveBatchOverseasInboundHandoff(orders)).toEqual({
      available: true,
      warehouseId: "warehouse-1",
      orderIds: ["order-1", "order-2", "order-3"],
    });
  });

  it("blocks the batch handoff when destination warehouses are missing or inconsistent", () => {
    expect(resolveBatchOverseasInboundHandoff([
      ...orders.slice(0, 2),
      { order_id: "order-3", overseas_warehouse_id: null },
    ])).toEqual({
      available: false,
      reason: "配载单有 1 票订单尚未指定境外目的仓，暂不能整批交接",
    });
    expect(resolveBatchOverseasInboundHandoff([
      ...orders.slice(0, 2),
      { order_id: "order-3", overseas_warehouse_id: "warehouse-2" },
    ])).toMatchObject({ available: false });
  });

  it("carries the PZ and all order ids to the warehouse without replacing site switching", () => {
    const href = buildBatchOverseasInboundHref({
      batchId: "batch-1",
      warehouseId: "warehouse-1",
      orderIds: ["order-1", "order-2", "order-3"],
      returnTo: "/admin/loading/batch-1?tab=overseas",
    });
    const url = new URL(href, "http://local.test");
    expect(url.pathname).toBe("/warehouse/inbound");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      warehouseId: "warehouse-1",
      batchId: "batch-1",
      orderIds: "order-1,order-2,order-3",
      returnTo: "/admin/loading/batch-1?tab=overseas",
    });
  });

  it("uses only requested ids that are actual PZ members", () => {
    expect(parseBatchInboundOrderIds("order-2, forged,order-2")).toEqual(["order-2", "forged"]);
    expect(resolveBatchInboundOrderFilter(
      orders.map((order) => order.order_id),
      ["order-2", "forged"],
    )).toEqual(["order-2"]);
  });
});
