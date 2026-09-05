import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    stageRows: [] as Array<{
      order_id: string;
      bound_instance_id: string | null;
      matched_instance_id: string | null;
      applies_to_current_or_future: number;
    }>,
    fieldRows: [] as Array<{
      order_id: string;
      field_key: string;
      is_active: number;
      is_required: number;
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
            results: query.includes("applies_to_current_or_future")
              ? state.stageRows
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

import { resolveLoadingBatchFieldPolicies } from "./loading-batch-field-policy";
import { loadLoadingBatchWorkflowOrders } from "./loading-batch-field-policy.server";

describe("loading batch frozen workflow binding", () => {
  beforeEach(() => {
    harness.sql.length = 0;
    harness.state.stageRows = [];
    harness.state.fieldRows = [];
  });

  it("rejects a non-null pointer that does not match the same organization and order", async () => {
    harness.state.stageRows = [{
      order_id: "order-1",
      bound_instance_id: "foreign-instance",
      matched_instance_id: null,
      applies_to_current_or_future: 1,
    }];

    await expect(loadLoadingBatchWorkflowOrders("org-1", ["order-1"]))
      .rejects.toThrow("工作流实例绑定异常");
    expect(harness.sql.join("\n")).toContain("wi.organization_id=o.organization_id");
    expect(harness.sql.join("\n")).toContain("wi.order_id=o.id");
  });

  it("keeps absent fields hidden for a valid frozen snapshot", async () => {
    harness.state.stageRows = [{
      order_id: "order-1",
      bound_instance_id: "instance-1",
      matched_instance_id: "instance-1",
      applies_to_current_or_future: 1,
    }];

    const orders = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);
    const policy = resolveLoadingBatchFieldPolicies(orders);

    expect(policy.exit_port).toMatchObject({
      isActive: false,
      isRequired: false,
      mode: "hidden",
    });
    expect(harness.sql.join("\n")).toContain("b.bound_instance_id IS NULL");
  });

  it("uses catalog defaults only for an explicitly unbound legacy order", async () => {
    harness.state.stageRows = [{
      order_id: "legacy-order",
      bound_instance_id: null,
      matched_instance_id: null,
      applies_to_current_or_future: 1,
    }];

    const orders = await loadLoadingBatchWorkflowOrders("org-1", ["legacy-order"]);
    const policy = resolveLoadingBatchFieldPolicies(orders);

    expect(policy.exit_port).toMatchObject({
      isActive: true,
      isRequired: true,
      mode: "required",
    });
  });
});
