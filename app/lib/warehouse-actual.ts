export type WarehouseActual = {
  pieces: number;
  weightKg: number;
  volumeCbm: number;
};

export type WarehouseDifference = {
  piecesPercent: number;
  weightPercent: number;
  volumePercent: number;
  maxPercent: number;
  hasDifference: boolean;
  requiresFeeConfirmation: boolean;
};

function differencePercent(planned: number, actual: number) {
  if (planned <= 0) return actual > 0 ? 100 : 0;
  return Math.abs(actual - planned) / planned * 100;
}

export function calculateWarehouseDifference(
  planned: WarehouseActual,
  actual: WarehouseActual,
): WarehouseDifference {
  const piecesPercent = differencePercent(planned.pieces, actual.pieces);
  const weightPercent = differencePercent(planned.weightKg, actual.weightKg);
  const volumePercent = differencePercent(planned.volumeCbm, actual.volumeCbm);
  const maxPercent = Math.max(piecesPercent, weightPercent, volumePercent);
  return {
    piecesPercent,
    weightPercent,
    volumePercent,
    maxPercent,
    hasDifference: maxPercent > 0.01,
    requiresFeeConfirmation: maxPercent > 5,
  };
}

export const roadStatusLabels: Record<string, string> = {
  waiting_loading: "等待配载",
  preplanned: "配载与车辆安排",
  loaded_waiting_exit: "已装车待出境",
  outbound_in_transit: "出境运输中",
  overseas_arrived: "境外到仓",
  waiting_pickup: "等待提货",
  pickup_completed: "提货完成",
  cancelled: "已取消",
};
