import { describe, expect, it } from "vitest";
import { resolveCustomerCode } from "./customer-code";

describe("customer code", () => {
  it("normalizes an operator supplied code", () => {
    expect(resolveCustomerCode("  VIP-SZ-01  ", "A2B3C")).toBe("vip-sz-01");
  });

  it("generates a stable code when customer code is left blank", () => {
    expect(resolveCustomerCode("", "A2B3C")).toBe("cus-a2b3c");
    expect(resolveCustomerCode("   ", "X8Y7Z")).toBe("cus-x8y7z");
  });
});
