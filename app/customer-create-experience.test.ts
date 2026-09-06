import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorUrl = new URL("./components/CustomerEditorForm.tsx", import.meta.url);
const editor = existsSync(editorUrl) ? readFileSync(editorUrl, "utf8") : "";
const customersRoute = readFileSync(new URL("./routes/admin.customers.tsx", import.meta.url), "utf8");
const quotationsRoute = readFileSync(new URL("./routes/admin.quotations.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

describe("customer creation experience contract", () => {
  it("organizes customer creation into peer tabs without remounting the form", () => {
    expect(editor).toContain('role="tablist"');
    expect(editor).toContain("基本资料");
    expect(editor).toContain("联系与提货");
    expect(editor).toContain("门户账号");
    expect(editor).toContain("合同归档");
    expect(editor).toContain("customer-editor-panel");
    expect(editor).not.toContain("key={`customer-editor-");
  });

  it("keeps the customer editor on a strict left-aligned grid", () => {
    expect(css).toContain("Customer editor alignment contract");
    expect(css).toContain(".customer-editor-form .customer-form-grid");
    expect(css).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(css).toContain("justify-self: stretch !important;");
    expect(css).toContain("max-width: none !important;");
  });

  it("can create a customer from the quotation form and select the created record", () => {
    expect(quotationsRoute).toContain("useFetcher");
    expect(quotationsRoute).toContain('action="/admin/customers"');
    expect(quotationsRoute).toContain("新增客户");
    expect(quotationsRoute).toContain("createdCustomerId");
    expect(quotationsRoute).toContain("selectCustomer(createdCustomerId)");
  });

  it("returns the created customer id and can atomically create initial dossier records", () => {
    expect(customersRoute).toContain('form.has("createPortal")');
    expect(customersRoute).toContain('form.has("archiveContract")');
    expect(customersRoute).toContain("customer_portal_accounts");
    expect(customersRoute).toContain("customer_contracts");
    expect(customersRoute).toContain('return { success: "客户已创建", customerId: id }');
  });
});
