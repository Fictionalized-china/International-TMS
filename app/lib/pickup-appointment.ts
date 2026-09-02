export const pickupAppointmentPeriods = [
  { value: "morning", label: "上午" },
  { value: "afternoon", label: "下午" },
  { value: "evening", label: "晚上" },
] as const;

export type PickupAppointmentPeriod =
  (typeof pickupAppointmentPeriods)[number]["value"];

export function isPickupAppointmentPeriod(
  value: string,
): value is PickupAppointmentPeriod {
  return pickupAppointmentPeriods.some((item) => item.value === value);
}

export function isPickupAppointmentDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function pickupAppointmentPeriodLabel(
  value: string | null | undefined,
) {
  return (
    pickupAppointmentPeriods.find((item) => item.value === value)?.label ?? ""
  );
}

export function formatPickupAppointment(
  appointmentAt: string | null | undefined,
  period: string | null | undefined,
) {
  if (!appointmentAt) return "未预约";
  const date = appointmentAt.slice(0, 10);
  const periodLabel = pickupAppointmentPeriodLabel(period);
  return periodLabel ? `${date} · ${periodLabel}` : date;
}
