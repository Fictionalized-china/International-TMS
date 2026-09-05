import { describe, expect, it } from "vitest";
import { resolveCustomsDeclarationWorkflowInput } from "./customs-declaration-workflow";

const now = "2026-09-05T12:00:00.000Z";
const field = (fieldKey: string, mode: "required" | "optional" | "hidden") => ({
  fieldKey,
  label: fieldKey,
  isActive: mode !== "hidden",
  isRequired: mode === "required",
});
const allKeys = [
  "customs_declarations", "declaration_stage", "declaration_status", "declaration_number",
  "declaration_type", "declaration_title", "declaring_company", "declared_at",
  "declared_amount", "declaration_currency", "declaration_gross_weight",
  "declaration_change_flags", "declaration_change_reason", "customs_release",
];
const fields = (mode: "required" | "optional" | "hidden") => allKeys.map((key) => field(key, mode));

describe("customs declaration workflow submission", () => {
  it("blocks an action when the declaration workbench is hidden", () => {
    const result = resolveCustomsDeclarationWorkflowInput({
      form: new FormData(), fields: fields("hidden"), now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toContain("未启用报关申报明细");
  });

  it("rejects a submitted value for a hidden workflow field", () => {
    const form = new FormData();
    form.set("declarationNumber", "CUS-1");
    const configured = fields("optional").map((item) =>
      item.fieldKey === "declaration_number" ? field(item.fieldKey, "hidden") : item,
    );
    const result = resolveCustomsDeclarationWorkflowInput({
      form, fields: configured, now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toContain("已隐藏“declaration_number”");
  });

  it("allows every optional visible field to be omitted and supplies neutral storage defaults", () => {
    const result = resolveCustomsDeclarationWorkflowInput({
      form: new FormData(), fields: fields("optional"), now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      declarationNumber: "AUTO-1",
      declarationType: "未配置",
      declaredAmount: 0,
      grossWeightKg: 0,
      declarationStatus: "declared",
    });
  });

  it("reports only required visible values as missing", () => {
    const configured = fields("optional").map((item) =>
      ["declaration_number", "declared_amount"].includes(item.fieldKey)
        ? field(item.fieldKey, "required")
        : item,
    );
    const result = resolveCustomsDeclarationWorkflowInput({
      form: new FormData(), fields: configured, now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toContain("declaration_number");
    expect(result.error).toContain("declared_amount");
  });

  it("preserves hidden values while editing without accepting a hidden mutation", () => {
    const existing = {
      clearance_stage: "origin", status: "declared", declaration_number: "CUS-OLD",
      declaration_type: "general", declaration_title: "title", declaring_company: "company",
      declared_at: now, declared_amount: 12, currency: "USD", gross_weight_kg: 34,
      released_at: null, is_deleted: 0, is_redeclared: 0, is_amended: 0,
      is_inspected: 0, change_reason: null,
    };
    const configured = fields("optional").map((item) =>
      item.fieldKey === "declaration_number" ? field(item.fieldKey, "hidden") : item,
    );
    const result = resolveCustomsDeclarationWorkflowInput({
      form: new FormData(), fields: configured, existing, now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.value?.declarationNumber).toBe("CUS-OLD");
  });

  it("rejects release when the release field is hidden", () => {
    const form = new FormData();
    form.set("releaseDeclaration", "1");
    const configured = fields("optional").map((item) =>
      item.fieldKey === "customs_release" ? field(item.fieldKey, "hidden") : item,
    );
    const result = resolveCustomsDeclarationWorkflowInput({
      form, fields: configured, now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toContain("已隐藏“customs_release”");
  });

  it("allows optional release and records the system event time when the operator omits it", () => {
    const form = new FormData();
    form.set("releaseDeclaration", "1");
    const result = resolveCustomsDeclarationWorkflowInput({
      form, fields: fields("optional"), now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toBeUndefined();
    expect(result.value?.releasedAt).toBe(now);
  });

  it("preserves declaration data when the dedicated release form posts only release fields", () => {
    const existing = {
      clearance_stage: "origin", status: "declared", declaration_number: "CUS-OLD",
      declaration_type: "general", declaration_title: "title", declaring_company: "company",
      declared_at: now, declared_amount: 12, currency: "USD", gross_weight_kg: 34,
      released_at: null, is_deleted: 0, is_redeclared: 0, is_amended: 0,
      is_inspected: 0, change_reason: null,
    };
    const form = new FormData();
    form.set("releaseDeclaration", "1");
    form.set("releasedAt", "2026-09-05T12:00");
    const configured = fields("required").map((item) =>
      ["declaration_change_flags", "declaration_change_reason"].includes(item.fieldKey)
        ? field(item.fieldKey, "optional")
        : item,
    );
    const result = resolveCustomsDeclarationWorkflowInput({
      form, fields: configured, existing, now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      declarationStatus: "released",
      declarationNumber: "CUS-OLD",
      declaringCompany: "company",
      releasedAt: "2026-09-05T12:00",
    });
  });

  it("does not turn optional change reason into a delete blocker", () => {
    const form = new FormData();
    form.set("isDeleted", "on");
    const result = resolveCustomsDeclarationWorkflowInput({
      form, fields: fields("optional"), now, autoDeclarationNumber: "AUTO-1",
    });
    expect(result.error).toBeUndefined();
    expect(result.value?.declarationStatus).toBe("cancelled");
  });
});
