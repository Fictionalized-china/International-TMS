import { describe, expect, it } from "vitest";
import { overseasInboundRequiresCustomsClearance } from "./overseas-inbound-policy";
import { frozenWorkflowFieldScopeMarkerKey } from "./workflow-field-runtime";

const field = (isActive: boolean, isRequired: boolean) => ({
  fieldKey: "customs_release",
  isActive,
  isRequired,
});

describe("overseasInboundRequiresCustomsClearance", () => {
  it("never blocks warehouse inbound for customer-managed clearance", () => {
    expect(overseasInboundRequiresCustomsClearance({
      customsClearanceMode: "customer",
      moduleEnabled: true,
      moduleRequired: true,
      fields: [field(true, true)],
    })).toBe(false);
  });

  it.each([
    { moduleEnabled: false, moduleRequired: true, fields: [field(true, true)] },
    { moduleEnabled: true, moduleRequired: false, fields: [field(true, true)] },
    { moduleEnabled: true, moduleRequired: true, fields: [field(false, false)] },
    { moduleEnabled: true, moduleRequired: true, fields: [field(true, false)] },
  ])("keeps hidden and optional workflow policy non-blocking", (policy) => {
    expect(overseasInboundRequiresCustomsClearance({
      customsClearanceMode: "company",
      ...policy,
    })).toBe(false);
  });

  it("blocks company-managed clearance only when module and release field are required", () => {
    expect(overseasInboundRequiresCustomsClearance({
      customsClearanceMode: "company",
      moduleEnabled: true,
      moduleRequired: true,
      fields: [field(true, true)],
    })).toBe(true);
  });

  it("keeps the historical empty-snapshot fallback required", () => {
    expect(overseasInboundRequiresCustomsClearance({
      customsClearanceMode: "company",
      moduleEnabled: true,
      moduleRequired: true,
      fields: [],
    })).toBe(true);
  });

  it("keeps a bound snapshot with no release field non-blocking", () => {
    expect(overseasInboundRequiresCustomsClearance({
      customsClearanceMode: "company",
      moduleEnabled: true,
      moduleRequired: true,
      fields: [{
        fieldKey: frozenWorkflowFieldScopeMarkerKey,
        isActive: false,
        isRequired: false,
      }],
    })).toBe(false);
  });
});
