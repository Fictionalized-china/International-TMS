export type BatchTransportDisplaySource = {
  carrier_name?: string | null;
  overseas_carrier_name?: string | null;
  overseas_vehicle_type?: string | null;
  overseas_vehicle_plate?: string | null;
  overseas_driver_name?: string | null;
  overseas_driver_phone?: string | null;
};

function joined(parts: readonly (string | null | undefined)[], fallback: string) {
  const value = [...new Set(parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)))].join(" · ");
  return value || fallback;
}

export function batchTransportDisplay(source: BatchTransportDisplaySource) {
  return {
    carrier: joined([source.overseas_carrier_name, source.carrier_name], "承运商待补"),
    vehicle: joined([source.overseas_vehicle_plate, source.overseas_vehicle_type], "车辆待补"),
    driver: joined([source.overseas_driver_name, source.overseas_driver_phone], "司机待补"),
  } as const;
}
