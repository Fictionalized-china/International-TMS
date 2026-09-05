import { describe, expect, it } from "vitest";
import {
  frozenWorkflowFieldScopeMarkerKey,
  hasVisibleRuntimeWorkflowField,
  runtimeWorkflowFieldPolicy,
} from "./workflow-field-runtime";

describe("runtimeWorkflowFieldPolicy", () => {
  const fields = [
    { fieldKey: "required", label: "必填字段", isActive: true, isRequired: true },
    { fieldKey: "optional", label: "选填字段", isActive: true, isRequired: false },
    { fieldKey: "hidden", label: "隐藏字段", isActive: false, isRequired: false },
  ];

  it("uses the bound workflow rule for required, optional and hidden fields", () => {
    expect(runtimeWorkflowFieldPolicy(fields, "required")).toMatchObject({
      visible: true,
      required: true,
      label: "必填字段",
    });
    expect(runtimeWorkflowFieldPolicy(fields, "optional", true)).toMatchObject({
      visible: true,
      required: false,
    });
    expect(runtimeWorkflowFieldPolicy(fields, "hidden", true)).toMatchObject({
      visible: false,
      required: false,
    });
  });

  it("does not expose an unregistered hard-coded field when a snapshot exists", () => {
    expect(runtimeWorkflowFieldPolicy(fields, "unknown", true)).toMatchObject({
      visible: false,
      required: false,
      configured: false,
    });
  });

  it("keeps the legacy fallback only for orders without a field snapshot", () => {
    expect(runtimeWorkflowFieldPolicy([], "legacy", true)).toMatchObject({
      visible: true,
      required: true,
      configured: false,
    });
  });

  it("does not treat an explicit frozen scope marker as a legacy empty array", () => {
    const frozenEmptyScope = [{
      fieldKey: frozenWorkflowFieldScopeMarkerKey,
      isActive: false,
      isRequired: false,
    }];
    expect(runtimeWorkflowFieldPolicy(
      frozenEmptyScope,
      "document_commercial_invoice",
      true,
    )).toMatchObject({
      visible: false,
      required: false,
      configured: false,
    });
  });

  it("detects visible composite table groups", () => {
    expect(hasVisibleRuntimeWorkflowField(fields, ["hidden", "optional"])).toBe(true);
    expect(hasVisibleRuntimeWorkflowField(fields, ["hidden", "unknown"])).toBe(false);
  });
});
