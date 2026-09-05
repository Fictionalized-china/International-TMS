import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    orderRows: [] as Array<{
      order_id: string;
      customs_enabled: number;
      workflow_instance_bound: number;
    }>,
    fieldRows: [] as Array<{
      order_id: string;
      module_code: "consignment" | "customs";
      field_key: string;
      is_active: number;
      is_required: number;
      stage_available?: number;
    }>,
  };
  const sql: string[] = [];
  const DB = {
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          return {
            results: query.includes("workflow_instance_bound")
              ? state.orderRows
              : state.fieldRows,
          };
        },
      };
      return statement;
    },
  };
  return { state, sql, DB };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));

import { loadOrderLoadingDocumentRequirements } from "./loading-document-requirements.server";

describe("loading document frozen requirements", () => {
  beforeEach(() => {
    harness.sql.length = 0;
    harness.state.orderRows = [];
    harness.state.fieldRows = [];
  });

  it("treats an empty bound snapshot as all hidden instead of catalog defaults", async () => {
    harness.state.orderRows = [{
      order_id: "order-1",
      customs_enabled: 1,
      workflow_instance_bound: 1,
    }];

    const [requirements] = await loadOrderLoadingDocumentRequirements(
      "org-1",
      ["order-1"],
    );

    expect(requirements.documents.length).toBeGreaterThan(0);
    expect(requirements.documents.every((document) =>
      !document.isActive && !document.isRequired,
    )).toBe(true);
    expect(harness.sql.join("\n")).toContain("b.bound_instance_id IS NULL");
    expect(harness.sql.join("\n")).toContain("wi.order_id=o.id");
  });

  it("keeps absent fields hidden when a bound snapshot contains only one file field", async () => {
    harness.state.orderRows = [{
      order_id: "order-1",
      customs_enabled: 1,
      workflow_instance_bound: 1,
    }];
    harness.state.fieldRows = [{
      order_id: "order-1",
      module_code: "customs",
      field_key: "document_commercial_invoice",
      is_active: 1,
      is_required: 0,
      stage_available: 0,
    }];

    const [requirements] = await loadOrderLoadingDocumentRequirements("org-1", ["order-1"]);
    expect(requirements.documents.find((item) => item.code === "commercial_invoice"))
      .toMatchObject({ isActive: true, isRequired: false, stageAvailable: false });
    expect(requirements.documents.find((item) => item.code === "packing_list"))
      .toMatchObject({ isActive: false, isRequired: false });
  });

  it("retains catalog defaults for an unbound legacy order", async () => {
    harness.state.orderRows = [{
      order_id: "legacy-order",
      customs_enabled: 1,
      workflow_instance_bound: 0,
    }];

    const [requirements] = await loadOrderLoadingDocumentRequirements(
      "org-1",
      ["legacy-order"],
    );
    expect(requirements.documents.find((item) => item.code === "commercial_invoice"))
      .toMatchObject({ isActive: true, isRequired: true });
    expect(harness.sql.join("\n")).toContain("field_step.sort_order<=current_step.sort_order");
  });
});
