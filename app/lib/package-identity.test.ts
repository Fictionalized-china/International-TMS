import { describe, expect, it } from "vitest";
import {
  inboundMarkCode,
  oulCode,
  parseInboundMarkSequence,
  pzNumber,
  randomOulSuffix,
  randomPzSuffix,
} from "./package-identity";

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

  it("creates order-owned OUL codes with sequence and total", () => {
    expect(oulCode("SO2026090800319", 2, 10, "A7K9"))
      .toBe("OUL-026090800319-002-010-A7K9");
    expect(randomOulSuffix(() => 0)).toBe("2222");
    expect(() => oulCode("SO-A", 4, 3, "A7K9")).toThrow("序号不能大于总数");
  });
});
