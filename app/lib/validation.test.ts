import { describe, expect, it } from "vitest";
import {
  requirePositiveInteger,
  requirePositiveNumber,
  validateCode,
  validateEmail,
  validatePassword,
} from "./validation";

describe("identity validation", () => {
  it("accepts a valid business email", () => expect(validateEmail("ops@oulingtruck.com")).toBeUndefined());
  it("rejects an invalid email", () => expect(validateEmail("not-an-email")).toBeTruthy());
  it("requires a strong initial password", () => {
    expect(validatePassword("short")).toBeTruthy();
    expect(validatePassword("StrongPassword2026")).toBeUndefined();
  });
  it("keeps organization and role codes URL safe", () => {
    expect(validateCode("ouling-cn")).toBeUndefined();
    expect(validateCode("Ouling CN")).toBeTruthy();
  });
});

describe("business number validation", () => {
  it.each(["0", "O", "-1", "", "Infinity", "NaN"])(
    "rejects non-positive or non-numeric amount %s",
    (value) => expect(() => requirePositiveNumber(value, "金额")).toThrow("金额必须大于 0"),
  );

  it("accepts a positive decimal amount", () => {
    expect(requirePositiveNumber("0.01", "金额")).toBe(0.01);
    expect(requirePositiveNumber("1250.75", "金额")).toBe(1250.75);
  });

  it.each(["0", "O", "-1", "1.5", "", "Infinity"])(
    "rejects invalid positive integer %s",
    (value) => expect(() => requirePositiveInteger(value, "件数")).toThrow("件数必须是大于 0 的整数"),
  );

  it("accepts a positive integer", () => {
    expect(requirePositiveInteger("12", "件数")).toBe(12);
  });
});
