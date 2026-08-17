import { describe, expect, it } from "vitest";
import {
  customerBusinessRoleLabel,
  isCustomerBusinessRoleCode,
  legacyCustomerTypeForRoles,
} from "./customer-business-roles";

describe("customer business roles", () => {
  it("recognizes supported role codes", () => {
    expect(isCustomerBusinessRoleCode("shipper")).toBe(true);
    expect(isCustomerBusinessRoleCode("unknown")).toBe(false);
    expect(customerBusinessRoleLabel("customs_broker")).toBe("报关行");
  });

  it("keeps a compatible legacy customer type", () => {
    expect(legacyCustomerTypeForRoles(["principal", "shipper"])).toBe("direct");
    expect(legacyCustomerTypeForRoles(["overseas_agent", "shipper"])).toBe("agent");
    expect(legacyCustomerTypeForRoles(["fee_party"])).toBe("partner");
  });
});
