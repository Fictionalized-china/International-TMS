import { describe, expect, it } from "vitest";
import { buildWarehousePackingPlan, type PackingSource } from "./warehouse-packing-plan";

function source(orderId: string, index: number): PackingSource {
  return {
    id: `source-${orderId}-${index}`,
    orderId,
    shipmentId: `shipment-${orderId}`,
    receiptId: `receipt-${orderId}`,
    locationId: `location-${orderId}`,
  };
}

function sequenceId() {
  let value = 0;
  return () => `id-${++value}`;
}

describe("buildWarehousePackingPlan", () => {
  it("creates order-owned outputs without invented source-to-output mapping", () => {
    const result = buildWarehousePackingPlan({
      requests: [{
        orderId: "order-a", orderNumber: "SO-A", sourceType: "ftl_order", transportBatchId: null,
        mode: "merge", outboundPackageCount: 6, totalWeightKg: 120, totalVolumeCbm: 0.6, notes: "",
      }],
      sources: Array.from({ length: 10 }, (_, index) => source("order-a", index + 1)),
      createId: sequenceId(),
      createOulCode: ({ orderNumber, sequence, total }) => `${orderNumber}-OUL-${sequence}-${total}`,
    });

    expect(result.batches[0]).toMatchObject({
      sourcePackageIds: expect.arrayContaining(["source-order-a-1", "source-order-a-10"]),
      outboundPackageCount: 6,
    });
    expect(result.batches[0].outputs).toHaveLength(6);
    expect(result.batches[0].outputs.every((item) => item.orderId === "order-a")).toBe(true);
    expect(result.batches[0].outputs.some((item) => "sourcePackageIds" in item)).toBe(false);
    expect(result.batches[0].outputs.every((item) => !("weightKg" in item) && !("volumeCbm" in item))).toBe(true);
  });

  it("preserves the inbound package count when preserve mode is selected", () => {
    const result = buildWarehousePackingPlan({
      requests: [{
        orderId: "order-a", orderNumber: "SO-A", sourceType: "ftl_order", transportBatchId: null,
        mode: "preserve", outboundPackageCount: 99, totalWeightKg: null, totalVolumeCbm: null, notes: "",
      }],
      sources: [source("order-a", 1), source("order-a", 2), source("order-a", 3)],
      createId: sequenceId(),
      createOulCode: ({ sequence, total }) => `OUL-${sequence}-${total}`,
    });

    expect(result.batches[0].outboundPackageCount).toBe(3);
    expect(result.batches[0].outputs).toHaveLength(3);
  });

  it("keeps each PZ order in its own packing batch", () => {
    const requests = [
      ["order-a", 6], ["order-b", 4], ["order-c", 3],
    ].map(([orderId, count]) => ({
      orderId: String(orderId), orderNumber: `SO-${orderId}`, sourceType: "pz_order" as const,
      transportBatchId: "pz-1", mode: "split" as const, outboundPackageCount: Number(count),
      totalWeightKg: null, totalVolumeCbm: null, notes: "",
    }));
    const sources = requests.flatMap((request) => [source(request.orderId, 1), source(request.orderId, 2)]);
    const result = buildWarehousePackingPlan({
      requests, sources, createId: sequenceId(),
      createOulCode: ({ orderNumber, sequence }) => `${orderNumber}-${sequence}`,
    });

    expect(result.batches.map((batch) => [batch.orderId, batch.outputs.length]))
      .toEqual([["order-a", 6], ["order-b", 4], ["order-c", 3]]);
    expect(result.batches.every((batch) => batch.transportBatchId === "pz-1")).toBe(true);
  });

  it("rejects missing sources, invalid counts and invalid request scope", () => {
    const valid = {
      orderId: "order-a", orderNumber: "SO-A", sourceType: "ftl_order" as const, transportBatchId: null,
      mode: "merge" as const, outboundPackageCount: 1, totalWeightKg: null, totalVolumeCbm: null, notes: "",
    };
    const build = (request: typeof valid, sources: PackingSource[]) => buildWarehousePackingPlan({
      requests: [request], sources, createId: sequenceId(),
      createOulCode: ({ sequence }) => `OUL-${sequence}`,
    });

    expect(() => build(valid, [])).toThrow("没有可用的入仓包裹");
    expect(() => build({ ...valid, outboundPackageCount: 0 }, [source("order-a", 1)])).toThrow("1–500");
    expect(() => build({ ...valid, sourceType: "pz_order" }, [source("order-a", 1)])).toThrow("配载单");
    expect(() => build({ ...valid, transportBatchId: "pz-1" }, [source("order-a", 1)])).toThrow("整车");
  });

  it("rejects source rows that do not belong to a requested order", () => {
    expect(() => buildWarehousePackingPlan({
      requests: [{
        orderId: "order-a", orderNumber: "SO-A", sourceType: "ftl_order", transportBatchId: null,
        mode: "merge", outboundPackageCount: 1, totalWeightKg: null, totalVolumeCbm: null, notes: "",
      }],
      sources: [source("order-a", 1), source("unknown", 1)],
      createId: sequenceId(), createOulCode: ({ sequence }) => `OUL-${sequence}`,
    })).toThrow("存在未选择订单的入仓包裹");
  });
});
