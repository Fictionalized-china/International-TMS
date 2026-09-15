import { describe, expect, it } from "vitest";
import {
  portalRegistrationLoginMessage,
  validatePortalRegistration,
} from "./portal-registration";

const validRegistration = {
  companyName: "深圳测试物流有限公司",
  customerIdentityCode: "A2B3C",
  displayName: "张三",
  email: "customer@example.com",
  phone: "+86 138 0000 0000",
  password: "SecurePortal2026",
  confirmPassword: "SecurePortal2026",
  acceptedTerms: true,
};

describe("portal self registration", () => {
  it("accepts complete registration information", () => {
    expect(validatePortalRegistration(validRegistration)).toEqual({});
  });

  it("returns field-level recovery messages", () => {
    const errors = validatePortalRegistration({
      ...validRegistration,
      customerIdentityCode: "O0001",
      email: "invalid",
      password: "short",
      confirmPassword: "different",
      acceptedTerms: false,
    });
    expect(errors).toMatchObject({
      customerIdentityCode: expect.any(String),
      email: expect.any(String),
      password: expect.any(String),
      confirmPassword: expect.any(String),
      acceptedTerms: expect.any(String),
    });
  });

  it("explains pending and rejected login states after password verification", () => {
    expect(portalRegistrationLoginMessage("pending")).toContain("审核中");
    expect(portalRegistrationLoginMessage("rejected", "企业资料不一致")).toContain("企业资料不一致");
  });
});
