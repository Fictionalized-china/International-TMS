export const domesticTransportGateFields = [
  { fieldKey: "domestic_carrier_id", label: "国内承运商" },
  { fieldKey: "domestic_vehicle_type", label: "国内车型" },
  { fieldKey: "domestic_plate_number", label: "国内车牌号" },
  { fieldKey: "domestic_driver_name", label: "国内司机姓名" },
  { fieldKey: "domestic_driver_phone", label: "国内司机手机号" },
  { fieldKey: "domestic_planned_departure_at", label: "计划提货时间" },
  { fieldKey: "domestic_planned_arrival_at", label: "计划到仓时间" },
] as const;

export type DomesticTransportGateFieldKey =
  (typeof domesticTransportGateFields)[number]["fieldKey"];

export type DomesticTransportGateAssignment = {
  carrier_id: string | null;
  carrier_name: string | null;
  vehicle_type: string | null;
  plate_number: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  planned_departure_at: string | null;
  planned_arrival_at: string | null;
};

const fieldValue = (
  assignment: DomesticTransportGateAssignment,
  fieldKey: DomesticTransportGateFieldKey,
) => {
  if (fieldKey === "domestic_carrier_id")
    return assignment.carrier_id || assignment.carrier_name;
  const assignmentKey = fieldKey.replace("domestic_", "") as Exclude<
    keyof DomesticTransportGateAssignment,
    "carrier_id" | "carrier_name"
  >;
  return assignment[assignmentKey];
};

export function missingDomesticTransportGateFields(
  requiredFieldKeys: readonly DomesticTransportGateFieldKey[],
  assignment: DomesticTransportGateAssignment | null,
) {
  if (!assignment) return [...requiredFieldKeys];
  return requiredFieldKeys.filter(
    (fieldKey) => !String(fieldValue(assignment, fieldKey) ?? "").trim(),
  );
}

export function domesticTransportGateFieldLabel(
  fieldKey: DomesticTransportGateFieldKey,
) {
  return (
    domesticTransportGateFields.find((field) => field.fieldKey === fieldKey)
      ?.label ?? fieldKey
  );
}
