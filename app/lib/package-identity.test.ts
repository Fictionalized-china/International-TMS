import { describe, expect, it } from "vitest";
import { inboundMarkCode, parseInboundMarkSequence, pzNumber, randomPzSuffix } from "./package-identity";

describe("package identity", () => {
  it("creates stable inbound mark codes", () => {
    expect(inboundMarkCode("SO2026090700307", 1)).toBe("SO2026090700307-IN-001");
    expect(parseInboundMarkSequence("SO2026090700307", "so2026090700307-in-012")).toBe(12);
  });

  it("creates compact PZ numbers without ambiguous characters", () => {
    expect(pzNumber({ warehouseSerialCode: "01", at: new Date("2026-09-07T00:00:00Z"), suffix: "A7K" }))
      .toBe("PZ-01-260907-A7K");
    expect(randomPzSuffix(() => 0)).toBe("222");
  });
});
