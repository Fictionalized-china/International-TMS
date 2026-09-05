import { hasOrderDocumentSystemOverride } from "./order-document-access";

export type DocumentReadUser = {
  permissions: readonly string[];
  positionCode?: string | null;
  roleCodes?: readonly string[];
};

const settlementSensitiveDocumentCategories = new Set([
  "billing_statement",
  "payment_receipt",
  "reconciliation_statement",
  "invoice_records",
  "cash_records",
  "writeoff_records",
  // Kept for pre-distribution attachments whose old category combined
  // invoices and expenses. Commercial invoices use commercial_invoice.
  "invoice",
]);

export function isSettlementSensitiveDocumentCategory(
  documentCategory: string | null | undefined,
) {
  return settlementSensitiveDocumentCategories.has(
    documentCategory?.trim().toLowerCase() ?? "",
  );
}

/**
 * Category authorization runs only after the caller has proved that the file
 * belongs to an order or batch inside the user's visibility scope.
 */
export function canReadScopedDocument(
  user: DocumentReadUser,
  documentCategory: string | null | undefined,
) {
  if (!user.permissions.includes("order.view")) return false;
  if (!isSettlementSensitiveDocumentCategory(documentCategory)) return true;
  return (
    user.permissions.includes("billing.sensitive.view") ||
    hasOrderDocumentSystemOverride(user)
  );
}
