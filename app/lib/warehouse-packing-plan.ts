import { assertPackageCount } from "./package-identity";

export type PackingMode = "preserve" | "merge" | "split";

export type PackingOrderRequest = {
  orderId: string;
  orderNumber: string;
  sourceType: "ftl_order" | "pz_order";
  transportBatchId: string | null;
  mode: PackingMode;
  outboundPackageCount: number;
  totalWeightKg: number | null;
  totalVolumeCbm: number | null;
  notes: string;
};

export type PackingSource = {
  id: string;
  orderId: string;
  shipmentId: string;
  receiptId: string;
  locationId: string;
};

export type PlannedPackingOutput = {
  id: string;
  code: string;
  orderId: string;
  shipmentId: string;
  receiptId: string;
  locationId: string;
};

export type PlannedPackingBatch = PackingOrderRequest & {
  id: string;
  sourcePackageIds: string[];
  outputs: PlannedPackingOutput[];
};

type BuildWarehousePackingPlanInput = {
  requests: PackingOrderRequest[];
  sources: PackingSource[];
  createId: () => string;
  createOulCode: (input: { orderNumber: string; sequence: number; total: number }) => string;
};

function optionalPositiveMeasure(value: number | null, label: string) {
  if (value !== null && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${label}必须大于 0，未实测时请留空`);
  }
  return value;
}

export function buildWarehousePackingPlan(input: BuildWarehousePackingPlanInput): { batches: PlannedPackingBatch[] } {
  if (input.requests.length === 0) throw new Error("至少选择一张订单");

  const requestIds = new Set<string>();
  for (const request of input.requests) {
    if (!request.orderId || !request.orderNumber) throw new Error("订单信息不完整");
    if (requestIds.has(request.orderId)) throw new Error(`订单 ${request.orderNumber} 重复提交`);
    requestIds.add(request.orderId);
    if (request.sourceType === "ftl_order" && request.transportBatchId !== null) {
      throw new Error(`整车订单 ${request.orderNumber} 不能关联配载单`);
    }
    if (request.sourceType === "pz_order" && !request.transportBatchId) {
      throw new Error(`配载单订单 ${request.orderNumber} 缺少配载单信息`);
    }
  }

  if (input.sources.some((source) => !requestIds.has(source.orderId))) {
    throw new Error("存在未选择订单的入仓包裹");
  }

  const sourceIds = new Set<string>();
  for (const source of input.sources) {
    if (sourceIds.has(source.id)) throw new Error(`入仓包裹 ${source.id} 重复`);
    sourceIds.add(source.id);
  }

  const batches = input.requests.map((request): PlannedPackingBatch => {
    const sources = input.sources.filter((source) => source.orderId === request.orderId);
    if (sources.length === 0) throw new Error(`订单 ${request.orderNumber} 没有可用的入仓包裹`);

    const outboundPackageCount = request.mode === "preserve"
      ? sources.length
      : assertPackageCount(request.outboundPackageCount, "最终出仓包裹数");
    assertPackageCount(outboundPackageCount, "最终出仓包裹数");
    optionalPositiveMeasure(request.totalWeightKg, "最终总重量");
    optionalPositiveMeasure(request.totalVolumeCbm, "最终总体积");

    const identity = sources[0];
    if (sources.some((source) =>
      source.shipmentId !== identity.shipmentId ||
      source.receiptId !== identity.receiptId ||
      source.locationId !== identity.locationId
    )) {
      throw new Error(`订单 ${request.orderNumber} 的入仓包裹归属不一致`);
    }

    return {
      ...request,
      id: input.createId(),
      outboundPackageCount,
      sourcePackageIds: sources.map((source) => source.id),
      outputs: Array.from({ length: outboundPackageCount }, (_, index) => ({
        id: input.createId(),
        code: input.createOulCode({
          orderNumber: request.orderNumber,
          sequence: index + 1,
          total: outboundPackageCount,
        }),
        orderId: request.orderId,
        shipmentId: identity.shipmentId,
        receiptId: identity.receiptId,
        locationId: identity.locationId,
      })),
    };
  });

  return { batches };
}
