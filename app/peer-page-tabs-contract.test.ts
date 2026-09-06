import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const peerTabSources = [
  "./components/CustomerEditorForm.tsx",
  "./routes/admin.billing.tsx",
  "./routes/admin.documents.tsx",
  "./routes/admin.loading-detail.tsx",
  "./routes/admin.master-data.tsx",
  "./routes/admin.order-detail.tsx",
  "./routes/admin.order-module.tsx",
  "./routes/admin.order-workbench.tsx",
  "./routes/admin.orders.tsx",
  "./routes/portal.account.tsx",
  "./routes/warehouse.cargo-consolidation.tsx",
  "./routes/warehouse.exceptions.tsx",
  "./routes/warehouse.index.tsx",
  "./routes/warehouse.outbound.tsx",
].map((path) => [path, readFileSync(new URL(path, import.meta.url), "utf8")] as const);

describe("system-wide peer page tab contract", () => {
  it("marks every peer-page navigation surface with one shared semantic class", () => {
    for (const [path, source] of peerTabSources) {
      expect(source, path).toContain("peer-page-tabs");
    }
  });

  it("covers the document scope and billing history page switches", () => {
    const billing = readFileSync(new URL("./routes/admin.billing.tsx", import.meta.url), "utf8");
    const documents = readFileSync(new URL("./routes/admin.documents.tsx", import.meta.url), "utf8");
    expect(billing).toContain('className="billing-history-switch peer-page-tabs"');
    expect(documents).toContain('className="document-scope-peer-page-tabs peer-page-tabs"');
  });

  it("makes page switching and the current page unmistakable", () => {
    const marker = css.lastIndexOf("System-wide peer page navigation");
    const contract = marker >= 0 ? css.slice(marker) : "";
    expect(marker).toBeGreaterThan(css.lastIndexOf("System-wide form geometry contract"));
    expect(contract).toContain('content: "页面导航｜以下为同级页面，点击名称切换";');
    expect(contract).toContain(".peer-page-tabs > :is(a, button)");
    expect(contract).toContain(".peer-page-tabs > :is(.active, [aria-current=\"page\"], [aria-selected=\"true\"])");
    expect(contract).toContain("box-shadow: inset 0 4px 0 #ff6b3d");
    expect(contract).toContain("background: #0b2f52 !important;");
    expect(contract).toContain("cursor: pointer;");
    expect(contract).toContain("overflow-x: auto;");
    expect(contract).toContain(".peer-page-tabs > input:checked + label");
  });
});
