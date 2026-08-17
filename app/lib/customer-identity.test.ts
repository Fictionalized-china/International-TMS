import { describe, expect, it } from "vitest";
import { generateCustomerIdentityCode, isValidCustomerIdentityCode } from "./customer-identity";

describe("customer identity code", () => {
  it("generates five unambiguous mixed characters", () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generateCustomerIdentityCode();
      expect(code).toHaveLength(5);
      expect(code).not.toMatch(/[O01L]/);
      expect(code).toMatch(/[A-Z]/);
      expect(code).toMatch(/[2-9]/);
      expect(isValidCustomerIdentityCode(code)).toBe(true);
    }
  });

  it("rejects ambiguous or non-mixed values", () => {
    expect(isValidCustomerIdentityCode("O2ABC")).toBe(false);
    expect(isValidCustomerIdentityCode("ABCDE")).toBe(false);
    expect(isValidCustomerIdentityCode("23456")).toBe(false);
  });
});
