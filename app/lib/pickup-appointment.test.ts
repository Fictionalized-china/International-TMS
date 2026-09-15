import { describe, expect, it } from "vitest";
import {
  formatPickupAppointment,
  isPickupAppointmentDate,
  isPickupAppointmentPeriod,
} from "./pickup-appointment";

describe("pickup appointment", () => {
  it("accepts only real calendar dates", () => {
    expect(isPickupAppointmentDate("2026-09-03")).toBe(true);
    expect(isPickupAppointmentDate("2026-02-30")).toBe(false);
    expect(isPickupAppointmentDate("2026/09/03")).toBe(false);
  });

  it("accepts only the three supported day periods", () => {
    expect(isPickupAppointmentPeriod("morning")).toBe(true);
    expect(isPickupAppointmentPeriod("afternoon")).toBe(true);
    expect(isPickupAppointmentPeriod("evening")).toBe(true);
    expect(isPickupAppointmentPeriod("night")).toBe(false);
  });

  it("formats warehouse and portal appointment status consistently", () => {
    expect(formatPickupAppointment(null, null)).toBe("未预约");
    expect(formatPickupAppointment("2026-09-04", "afternoon")).toBe(
      "2026-09-04 · 下午",
    );
  });
});
