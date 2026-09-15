export type BatchOverseasInboundOrder = {
  order_id: string;
  overseas_warehouse_id: string | null;
};

export type BatchOverseasInboundHandoff =
  | { available: true; warehouseId: string; orderIds: string[] }
  | { available: false; reason: string };

export function resolveBatchOverseasInboundHandoff(
  orders: readonly BatchOverseasInboundOrder[],
): BatchOverseasInboundHandoff {
  if (!orders.length) return { available: false, reason: "配载单没有可收货的挂载订单" };

  const missingWarehouseCount = orders.filter((order) => !order.overseas_warehouse_id).length;
  if (missingWarehouseCount) {
    return {
      available: false,
      reason: `配载单有 ${missingWarehouseCount} 票订单尚未指定境外目的仓，暂不能整批交接`,
    };
  }

  const warehouseIds = [...new Set(orders.map((order) => order.overseas_warehouse_id as string))];
  if (warehouseIds.length !== 1) {
    return {
      available: false,
      reason: "配载单内订单指向不同境外目的仓，请先调整路线后再整批交接",
    };
  }

  return {
    available: true,
    warehouseId: warehouseIds[0],
    orderIds: [...new Set(orders.map((order) => order.order_id).filter(Boolean))],
  };
}

export function buildBatchOverseasInboundHref(input: {
  batchId: string;
  warehouseId: string;
  orderIds: readonly string[];
  returnTo: string;
}) {
  const search = new URLSearchParams({
    warehouseId: input.warehouseId,
    batchId: input.batchId,
    orderIds: [...new Set(input.orderIds)].join(","),
    returnTo: input.returnTo,
  });
  return `/warehouse/inbound?${search.toString()}`;
}

export function parseBatchInboundOrderIds(raw: string | null) {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

export function resolveBatchInboundOrderFilter(
  batchMemberOrderIds: readonly string[],
  requestedOrderIds: readonly string[],
) {
  const memberIds = [...new Set(batchMemberOrderIds.filter(Boolean))];
  if (!requestedOrderIds.length) return memberIds;
  const requested = new Set(requestedOrderIds);
  return memberIds.filter((orderId) => requested.has(orderId));
}
