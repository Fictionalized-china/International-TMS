import { describe, expect, it } from "vitest";
import { validateCode, validateEmail, validatePassword } from "./validation";

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
