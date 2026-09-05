import { describe, expect, it } from "vitest";
import { canReadScopedDocument } from "./order-document-visibility";

describe("order and batch document read visibility", () => {
  it("lets an order-scoped reader open and download ordinary business files without document management", () => {
    const operation = {
      permissions: ["order.view", "order.scope.assigned"],
      positionCode: "OPERATION",
      roleCodes: ["pos_operation"],
    };

    expect(canReadScopedDocument(operation, "commercial_invoice")).toBe(true);
    expect(canReadScopedDocument(operation, "loading_manifest")).toBe(true);
  });

  it("requires sensitive billing visibility for settlement documents", () => {
    const documentManager = {
      permissions: [
        "order.view",
        "order.scope.assigned",
        "order.module.documents.manage",
      ],
      positionCode: "DOC",
      roleCodes: ["pos_doc"],
    };
    const financeReader = {
      permissions: [
        "order.view",
        "order.scope.all",
        "billing.sensitive.view",
      ],
      positionCode: "FINANCE_ACCOUNTING",
      roleCodes: ["pos_finance"],
    };

    expect(canReadScopedDocument(documentManager, "billing_statement")).toBe(
      false,
    );
    expect(canReadScopedDocument(documentManager, "payment_receipt")).toBe(
      false,
    );
    expect(canReadScopedDocument(financeReader, "billing_statement")).toBe(
      true,
    );
    expect(canReadScopedDocument(financeReader, "payment_receipt")).toBe(true);
  });

  it.each([
    ["boss position", "BOSS", ["pos_boss"]],
    ["developer position", "DEVELOPER", ["pos_developer"]],
    ["owner role", "GENERAL_MANAGER", ["owner"]],
    ["developer role", "TECH", ["developer"]],
  ])("keeps the %s fallback for sensitive documents", (_, positionCode, roleCodes) => {
    expect(
      canReadScopedDocument(
        { permissions: ["order.view"], positionCode, roleCodes },
        "billing_statement",
      ),
    ).toBe(true);
  });

  it("never substitutes write or billing permissions for order.view", () => {
    const permissions = [
      "order.module.documents.manage",
      "billing.sensitive.view",
    ];

    expect(
      canReadScopedDocument({ permissions }, "commercial_invoice"),
    ).toBe(false);
    expect(canReadScopedDocument({ permissions }, "billing_statement")).toBe(
      false,
    );
  });

  it.each([
    "reconciliation_statement",
    "invoice_records",
    "cash_records",
    "writeoff_records",
    "invoice",
  ])("treats settlement-derived category %s as sensitive", (documentCategory) => {
    expect(
      canReadScopedDocument(
        {
          permissions: [
            "order.view",
            "order.module.documents.manage",
          ],
          positionCode: "DOC",
        },
        documentCategory,
      ),
    ).toBe(false);
  });
});
