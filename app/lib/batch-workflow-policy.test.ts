import { describe, expect, it } from "vitest";
import {
  batchWorkflowFieldPolicy,
  batchWorkflowModulePolicy,
  orderWorkflowFieldBlocksBatch,
  validateBatchWorkflowFormSubmission,
  type BatchOrderWorkflowPolicy,
} from "./batch-workflow-policy";

const policy = (
  orderId: string,
  moduleCode: BatchOrderWorkflowPolicy["moduleCode"],
  moduleMode: "required" | "optional" | "hidden",
  fieldMode: "required" | "optional" | "hidden",
): BatchOrderWorkflowPolicy => ({
  orderId,
  businessType: "ltl",
  moduleCode,
  enabled: moduleMode !== "hidden",
  required: moduleMode === "required",
  fields: [{
    fieldKey: "target",
    label: "目标字段",
    isActive: fieldMode !== "hidden",
    isRequired: fieldMode === "required",
  }],
});

describe("batch workflow policy", () => {
  it("keeps an optional module actionable without turning it into a progress gate", () => {
    const policies = [policy("order-1", "customs", "optional", "required")];
    expect(batchWorkflowModulePolicy(policies, "customs")).toMatchObject({
      enabled: true,
      required: false,
    });
    expect(batchWorkflowFieldPolicy(policies, "customs", "target")).toMatchObject({
      visible: true,
      required: true,
    });
    expect(orderWorkflowFieldBlocksBatch(policies, "order-1", "customs", "target")).toBe(false);
  });

  it("blocks only when both the module and field are required", () => {
    expect(orderWorkflowFieldBlocksBatch(
      [policy("order-1", "tracking", "required", "required")],
      "order-1", "tracking", "target",
    )).toBe(true);
    expect(orderWorkflowFieldBlocksBatch(
      [policy("order-1", "tracking", "required", "optional")],
      "order-1", "tracking", "target",
    )).toBe(false);
  });

  it("hides a field when every enabled order hides it", () => {
    const policies = [
      policy("order-1", "loading", "required", "hidden"),
      policy("order-2", "loading", "optional", "hidden"),
    ];
    expect(batchWorkflowFieldPolicy(policies, "loading", "target")).toMatchObject({
      visible: false,
      required: false,
    });
  });

  it("uses the union for a shared form and the strongest visible field mode", () => {
    const policies = [
      policy("order-1", "loading", "required", "hidden"),
      policy("order-2", "loading", "optional", "optional"),
      policy("order-3", "loading", "required", "required"),
    ];
    expect(batchWorkflowFieldPolicy(policies, "loading", "target")).toMatchObject({
      visible: true,
      required: true,
      label: "目标字段",
    });
  });

  it("rejects values posted for a hidden field", () => {
    const form = new FormData();
    form.set("location", "阿拉山口");
    expect(validateBatchWorkflowFormSubmission(
      [policy("order-1", "tracking", "required", "hidden")],
      form,
      [{ moduleCode: "tracking", fieldKey: "target", formNames: ["location"], label: "运踪地点" }],
    )).toBe("当前工作流已隐藏“运踪地点”，不能提交该字段");
  });

  it("allows an omitted optional field but rejects an omitted required field", () => {
    const optional = policy("order-1", "tracking", "required", "optional");
    const required = policy("order-1", "tracking", "required", "required");
    const binding = [{ moduleCode: "tracking" as const, fieldKey: "target", formNames: ["location"], label: "运踪地点" }];
    expect(validateBatchWorkflowFormSubmission([optional], new FormData(), binding)).toBeNull();
    expect(validateBatchWorkflowFormSubmission([required], new FormData(), binding)).toBe("请填写当前工作流要求的字段：目标字段");
  });
});
