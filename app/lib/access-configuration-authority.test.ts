import { describe, expect, it } from "vitest";
import { canManageAccessConfiguration } from "./access-configuration-authority";

describe("access configuration authority", () => {
  it.each(["BOSS", "DEVELOPER", "HR_ADMIN"])("allows %s to configure position permissions", (positionCode) => {
    expect(canManageAccessConfiguration({ permissions: [], positionCode, roleCodes: [] })).toBe(true);
  });

  it("does not treat ordinary business roles as access administrators", () => {
    expect(canManageAccessConfiguration({
      permissions: ["order.manage"],
      positionCode: "OPERATION",
      roleCodes: ["pos_operation"],
    })).toBe(false);
  });
});
