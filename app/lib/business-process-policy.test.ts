import { describe, expect, it } from "vitest";
import { defaultBusinessProcessPolicy, policyPositions, resolveBusinessProcessPolicy, validateBusinessProcessPolicy } from "./business-process-policy";
describe("configurable meeting business policy", () => {
  it("uses the final meeting responsibilities, not the superseded business supervisor", () => {
    expect(policyPositions(defaultBusinessProcessPolicy, "order.approve_positions")).toEqual(["OPERATION_SUPERVISOR"]);
    expect(policyPositions(defaultBusinessProcessPolicy, "payable.initiator_positions")).toContain("BUSINESS_ROUTE");
  });
  it("rejects empty actors and invalid switches instead of creating deadlocks", () => {
    expect(() => validateBusinessProcessPolicy({ "order.approve_positions": "" })).toThrow("无人可办理");
    expect(() => validateBusinessProcessPolicy({ "dispatch.enabled": "true" })).toThrow();
  });
  it("allows disabling a capability without deleting its historical data", () => {
    expect(resolveBusinessProcessPolicy([{ policy_key: "tracking.daily_enabled", policy_value: "0" }])["tracking.daily_enabled"]).toBe("0");
  });
  it("deduplicates actor codes and ignores unknown persisted keys", () => {
    expect(validateBusinessProcessPolicy({ "order.submit_positions": "SALES,CS,SALES" })["order.submit_positions"]).toBe("SALES,CS");
    expect(resolveBusinessProcessPolicy([{ policy_key: "unknown", policy_value: "x" }])).toEqual(defaultBusinessProcessPolicy);
  });
});
