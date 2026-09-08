import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const route = readFileSync(new URL("./routes/admin.order-module.tsx", import.meta.url), "utf8");
const marker = "Domestic transport: task-focused tabs and a single-screen compact entry sheet.";
const start = css.indexOf(marker);
const contract = start >= 0 ? css.slice(start, css.indexOf("/* Compact flat-table workbench", start)) : "";

describe("domestic transport layout contract", () => {
  it("keeps the arrangement form stretched across the available module width", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(contract).toContain(".transport-create-panel .transport-entry-forms");
    expect(contract).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(contract).toContain("align-items: stretch;");
    expect(contract).toContain(".transport-compact-form {\n  width: 100%;\n  min-width: 0;");
  });

  it("fills each semantic grid cell without allowing global field widths to shrink controls", () => {
    expect(contract).toContain(".linear-order-page .transport-compact-form input");
    expect(contract).toContain("width: 100% !important;");
    expect(contract).toContain("max-width: none !important;");
    expect(contract).toContain("justify-self: stretch !important;");
  });

  it("does not render registered-driver details beside the new-driver fields", () => {
    expect(route).toContain('domesticDriverId !== "__new__" && <>');
    expect(route).toContain('fieldKey="domestic_driver_phone"');
    expect(route).toContain('fieldKey="domestic_driver_id_number"');
  });
});
