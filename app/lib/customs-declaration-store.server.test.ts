import { describe, expect, it, vi } from "vitest";
import { loadExistingCustomsDeclarationForMutation } from "./customs-declaration-store.server";

describe("loadExistingCustomsDeclarationForMutation", () => {
  it("loads the clearance stage from the customs record instead of the declaration table", async () => {
    const declaration = {
      customs_record_id: "record-1",
      clearance_stage: "origin",
      status: "declared",
      declaration_number: "CUS-001",
      declaration_type: "export",
      declaration_title: "Example declaration",
      declaring_company: "Example broker",
      declared_at: "2026-09-06T08:00:00.000Z",
      declared_amount: 100,
      currency: "USD",
      gross_weight_kg: 50,
      released_at: null,
      is_deleted: 0,
      is_redeclared: 0,
      is_amended: 0,
      is_inspected: 0,
      change_reason: null,
    };
    const first = vi.fn(async () => declaration);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn((_sql: string) => ({ bind }));

    const result = await loadExistingCustomsDeclarationForMutation(
      { prepare } as unknown as D1Database,
      {
        declarationId: "declaration-1",
        organizationId: "org-1",
        orderId: "order-1",
      },
    );

    expect(result).toEqual(declaration);
    expect(bind).toHaveBeenCalledWith("declaration-1", "org-1", "order-1");
    const sql = String(prepare.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
    expect(sql).toContain("FROM order_customs_declarations d");
    expect(sql).toContain("JOIN order_customs_records r");
    expect(sql).toMatch(/r\.clearance_stage\s+AS\s+clearance_stage/);
    expect(sql).not.toMatch(/SELECT\s+d\.customs_record_id\s*,\s*d\.clearance_stage/);
  });
});
