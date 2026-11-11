import { readIntakeOperations } from "./intake-operations";

/** Display current services, never the opening quotation's planned selection. */
export function consignmentIntakeOperations(raw: unknown, services: readonly { service_code: string; status: string }[]) {
  return {
    ...readIntakeOperations(raw),
    entrustedServices: [...new Set(services.filter(service => service.status !== "cancelled").map(service => service.service_code))],
  };
}

type ConsignmentCargo = {
  declared_quantity: number | null;
  declared_unit: string | null;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  volume_per_package_cbm: number;
};

/** Product quantities keep their own units; only historical NULL uses pieces. */
export function consignmentCargoSummary(cargo: readonly ConsignmentCargo[], defaultUnit: string | null) {
  const quantities = new Map<string, number>();
  let packageCount = 0, grossWeight = 0, volume = 0, missingQuantity = 0;
  for (const item of cargo) {
    packageCount += Number(item.package_count);
    grossWeight += Number(item.package_count) * Number(item.gross_weight_per_package_kg);
    volume += Number(item.package_count) * Number(item.volume_per_package_cbm);
    const quantity = item.declared_quantity == null
      ? Number(item.package_count) * Number(item.pieces_per_package)
      : Number(item.declared_quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) { missingQuantity += 1; continue; }
    const unit = item.declared_unit?.trim() || defaultUnit?.trim() || "件";
    quantities.set(unit, (quantities.get(unit) ?? 0) + quantity);
  }
  const labels = [...quantities].map(([unit, quantity]) => `${quantity.toLocaleString("zh-CN", { maximumFractionDigits: 20 })} ${unit}`);
  if (missingQuantity) labels.push(`${missingQuantity} 条商品数量待补录`);
  return { packageCount, grossWeight, volume, quantityLabel: labels.join("、") || "尚未记录商品数量" };
}
