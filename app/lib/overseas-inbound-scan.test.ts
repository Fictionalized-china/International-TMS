import { describe, expect, it } from "vitest";
import { initialOverseasInboundScans } from "./overseas-inbound-scan";

const packages = [
  {
    barcode: "OUL-026090800322-001-001-JEB4",
    package_number: "OUTBOUND-001",
  },
  {
    barcode: "OUL-026090800322-002-002-H7K2",
    package_number: "OUTBOUND-002",
  },
];

describe("initialOverseasInboundScans", () => {
  it("counts the first scanned OUL immediately", () => {
    expect(initialOverseasInboundScans(
      "oul-026090800322-001-001-jeb4",
      packages,
    )).toEqual(["OUL-026090800322-001-001-JEB4"]);
  });

  it("accepts a package-number alias but stores the canonical OUL barcode", () => {
    expect(initialOverseasInboundScans("OUTBOUND-002", packages)).toEqual([
      "OUL-026090800322-002-002-H7K2",
    ]);
  });

  it("does not count an OUT loading-task code as a scanned package", () => {
    expect(initialOverseasInboundScans("OUT-260908-ABC12", packages)).toEqual([]);
  });
});
