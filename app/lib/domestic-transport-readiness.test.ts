import { describe, expect, it } from "vitest";
import {
  missingDomesticTransportGateFields,
  type DomesticTransportGateAssignment,
} from "./domestic-transport-readiness";

const assignment = (
  patch: Partial<DomesticTransportGateAssignment> = {},
): DomesticTransportGateAssignment => ({
  carrier_id: "carrier-1",
  carrier_name: "测试国内承运商",
  vehicle_type: null,
  plate_number: null,
  driver_name: null,
  driver_phone: null,
  planned_departure_at: "2026-09-02T14:53",
  planned_arrival_at: null,
  ...patch,
});

describe("missingDomesticTransportGateFields", () => {
  it("does not turn optional vehicle fields into a later loading blocker", () => {
    expect(
      missingDomesticTransportGateFields(
        ["domestic_carrier_id", "domestic_planned_departure_at"],
        assignment(),
      ),
    ).toEqual([]);
  });

  it("reports only fields that the order workflow actually requires", () => {
    expect(
      missingDomesticTransportGateFields(
        ["domestic_carrier_id", "domestic_plate_number", "domestic_driver_name"],
        assignment({ plate_number: "湘A12345" }),
      ),
    ).toEqual(["domestic_driver_name"]);
  });

  it("accepts a preserved carrier name when legacy data has no carrier id", () => {
    expect(
      missingDomesticTransportGateFields(
        ["domestic_carrier_id"],
        assignment({ carrier_id: null }),
      ),
    ).toEqual([]);
  });

  it("reports every required field when no domestic assignment exists", () => {
    expect(
      missingDomesticTransportGateFields(
        ["domestic_carrier_id", "domestic_planned_arrival_at"],
        null,
      ),
    ).toEqual(["domestic_carrier_id", "domestic_planned_arrival_at"]);
  });
});
