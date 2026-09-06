import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const contractMarker = "System-wide form geometry contract";
const contractStart = css.indexOf(contractMarker);
const contract = contractStart >= 0 ? css.slice(contractStart) : "";

describe("system-wide form geometry contract", () => {
  it("uses one fixed height for editable inputs and native dropdowns on every form surface", () => {
    expect(contractStart).toBeGreaterThanOrEqual(0);
    expect(contract).toContain("--form-control-height: var(--ui-control-height, 32px);");
    expect(contract).toContain(".modal-card .modal-body");
    expect(contract).toContain(".auth-card");
    expect(contract).toContain("select:not([multiple])");
    expect(contract).toContain("height: var(--form-control-height) !important;");
    expect(contract).toContain("min-height: var(--form-control-height) !important;");
    expect(contract).toContain("max-height: var(--form-control-height) !important;");
  });

  it("fixes every multiline text box at exactly three single-line control heights", () => {
    expect(contract).toContain(
      "--form-textarea-height: calc(var(--form-control-height) + var(--form-control-height) + var(--form-control-height));",
    );
    expect(contract).toContain("textarea");
    expect(contract).toContain("height: var(--form-textarea-height) !important;");
    expect(contract).toContain("min-height: var(--form-textarea-height) !important;");
    expect(contract).toContain("max-height: var(--form-textarea-height) !important;");
    expect(contract).toContain("resize: none !important;");
  });

  it("keeps short-value controls content-sized instead of stretching across spare grid space", () => {
    expect(contract).toContain("--form-width-micro: 8rem;");
    expect(contract).toContain("--form-width-short: 12rem;");
    expect(contract).toContain("--form-width-medium: 18rem;");
    expect(contract).toContain("--form-width-long: 26rem;");
    expect(contract).toContain(".field-short > :is(input, select)");
    expect(contract).toContain(".field-medium > :is(input, select)");
    expect(contract).toContain(".field-wide > :is(input, select)");
    expect(contract).toContain('[name="currency" i]');
    expect(contract).toContain('select[name="severity" i]');
    expect(contract).toContain('select[name$="Id" i]');
    expect(contract).toContain('[name$="Status" i]');
    expect(contract).toContain('input[type="number"]');
    expect(contract).toContain("justify-self: start;");
  });

  it("aligns custom single-value pickers with native controls", () => {
    expect(contract).toContain(".organization-assignee-trigger");
    expect(contract).toContain(".customer-role-dropdown > summary > strong");
    expect(contract).toContain(".quote-contact-combobox");
  });
});
