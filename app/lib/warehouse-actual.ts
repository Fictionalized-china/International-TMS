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

export const DEFAULT_WAREHOUSE_DIFFERENCE_THRESHOLD_PERCENT = 5;

function roundMeasurement(value: number, precision: number) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function differencePercent(planned: number, actual: number, precision: number) {
  const normalizedPlanned = roundMeasurement(planned, precision);
  const normalizedActual = roundMeasurement(actual, precision);
  if (normalizedPlanned === normalizedActual) return 0;
  if (normalizedPlanned <= 0) return normalizedActual > 0 ? 100 : 0;
  return Math.abs(normalizedActual - normalizedPlanned) / normalizedPlanned * 100;
}

export function calculateWarehouseDifference(
  planned: WarehouseActual,
  actual: WarehouseActual,
  thresholdPercent = DEFAULT_WAREHOUSE_DIFFERENCE_THRESHOLD_PERCENT,
): WarehouseDifference {
  // Keep comparison precision aligned with the values the operator can see and
  // enter. This prevents hidden floating-point tails from creating a warehouse
  // exception while both sides appear identical on screen.
  const piecesPercent = differencePercent(planned.pieces, actual.pieces, 0);
  const weightPercent = differencePercent(planned.weightKg, actual.weightKg, 2);
  const volumePercent = differencePercent(planned.volumeCbm, actual.volumeCbm, 3);
  const maxPercent = Math.max(piecesPercent, weightPercent, volumePercent);
  const safeThreshold = Number.isFinite(thresholdPercent) && thresholdPercent >= 0
    ? thresholdPercent
    : DEFAULT_WAREHOUSE_DIFFERENCE_THRESHOLD_PERCENT;
  return {
    piecesPercent,
    weightPercent,
    volumePercent,
    maxPercent,
    hasDifference: maxPercent > 0.01,
    requiresFeeConfirmation: maxPercent > safeThreshold,
  };
}

export function shouldCreateWarehouseDifference(input: {
  difference: WarehouseDifference;
  packageMismatch?: boolean;
  piecesMismatch?: boolean;
}) {
  return input.difference.requiresFeeConfirmation ||
    Boolean(input.packageMismatch) ||
    Boolean(input.piecesMismatch);
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

export function displayWarehouseMeasuredCount(value: number | null | undefined) {
  return value != null && Number(value) > 0 ? Number(value) : "—";
}

export function displayWarehouseMeasuredDimensions(
  lengthCm: number | null | undefined,
  widthCm: number | null | undefined,
  heightCm: number | null | undefined,
) {
  const dimensions = [lengthCm, widthCm, heightCm].map(Number);
  return dimensions.every((value) => Number.isFinite(value) && value > 0)
    ? dimensions.join(" × ")
    : "—";
}

export function displayWarehouseMeasuredDimensionSummary(value: string | null | undefined) {
  if (!value) return "—";
  const measured = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => {
      const dimensions = item.split("×").map((part) => Number(part.trim()));
      return dimensions.length === 3 && dimensions.every((dimension) => Number.isFinite(dimension) && dimension > 0);
    });
  return measured.length ? measured.join("、") : "—";
}
