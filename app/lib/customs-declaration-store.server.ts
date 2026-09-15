import type { ExistingCustomsDeclarationInput } from "./customs-declaration-workflow";

export type ExistingCustomsDeclarationRecord = ExistingCustomsDeclarationInput & {
  customs_record_id: string;
};

export async function loadExistingCustomsDeclarationForMutation(
  db: D1Database,
  input: {
    declarationId: string;
    organizationId: string;
    orderId: string;
  },
): Promise<ExistingCustomsDeclarationRecord | null> {
  return await db.prepare(
    `SELECT d.customs_record_id,r.clearance_stage AS clearance_stage,d.status,d.declaration_number,
            d.declaration_type,d.declaration_title,d.declaring_company,d.declared_at,d.declared_amount,
            d.currency,d.gross_weight_kg,d.released_at,d.is_deleted,d.is_redeclared,d.is_amended,
            d.is_inspected,d.change_reason
     FROM order_customs_declarations d
     JOIN order_customs_records r
       ON r.id=d.customs_record_id
      AND r.organization_id=d.organization_id
      AND r.order_id=d.order_id
     WHERE d.id=? AND d.organization_id=? AND d.order_id=?`,
  ).bind(
    input.declarationId,
    input.organizationId,
    input.orderId,
  ).first<ExistingCustomsDeclarationRecord>() ?? null;
}
