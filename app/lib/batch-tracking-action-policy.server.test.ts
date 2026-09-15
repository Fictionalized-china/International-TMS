import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

const harness = vi.hoisted(() => ({
  contexts: new Map<string, LockedWorkflowStageContext>(),
  fields: new Map<string, Array<{
    module_code: string;
    field_key: string;
    step_key: string;
    is_active: number;
    is_required: number;
  }>>(),
  queries: [] as string[],
  bindings: [] as unknown[][],
}));

vi.mock("./workflow-instance-stage-gate.server", () => ({
  loadLockedWorkflowStageContext: vi.fn(
    async (_db: D1Database, _organizationId: string, orderId: string) =>
      harness.contexts.get(orderId),
  ),
}));

import { loadBatchTrackingActionPolicy } from "./batch-tracking-action-policy.server";

function context(
  currentStepKey: string,
  locked = true,
): LockedWorkflowStageContext {
  if (!locked) {
    return {
      locked: false,
      currentStepKey: null,
      steps: [],
      modulePlacements: [],
      fields: [],
    };
  }
  return {
    locked: true,
    currentStepKey,
    steps: [
      { stepKey: "customs", stepName: "报关放行", sortOrder: 10 },
      { stepKey: "tracking", stepName: "实际出境及运踪", sortOrder: 20 },
      { stepKey: "overseas", stepName: "境外仓入库", sortOrder: 30 },
    ],
    modulePlacements: [
      { moduleCode: "tracking", stepKey: "tracking" },
    ],
    fields: [],
  };
}

function trackingField(moduleCode = "tracking") {
  return {
    module_code: moduleCode,
    field_key: "tracking_milestone",
    step_key: "tracking",
    is_active: 1,
    is_required: 1,
  };
}

function database(): D1Database {
  return {
    prepare(sql: string) {
      harness.queries.push(sql);
      const statement = {
        bindings: [] as unknown[],
        bind(...values: unknown[]) {
          statement.bindings = values;
          harness.bindings.push(values);
          return statement;
        },
        async all() {
          const orderId = String(statement.bindings[1]);
          return { results: harness.fields.get(orderId) ?? [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("batch tracking frozen action policy loader", () => {
  beforeEach(() => {
    harness.contexts.clear();
    harness.fields.clear();
    harness.queries.length = 0;
    harness.bindings.length = 0;
  });

  it("loads each frozen field through the order-bound instance and aggregates exact-step access", async () => {
    harness.contexts.set("order-1", context("tracking"));
    harness.contexts.set("order-2", context("customs"));
    harness.fields.set("order-1", [trackingField()]);
    harness.fields.set("order-2", [trackingField()]);

    const result = await loadBatchTrackingActionPolicy({
      db: database(),
      organizationId: "org-1",
      orders: [
        { orderId: "order-1", orderNumber: "SO-001" },
        { orderId: "order-2", orderNumber: "SO-002" },
      ],
      fieldKey: "tracking_milestone",
    });

    expect(result.batch).toMatchObject({
      status: "read_only",
      editable: false,
      editableOrderIds: ["order-1"],
      readOnlyOrderIds: ["order-2"],
    });
    expect(result.orders.map((item) => item.policy.status)).toEqual([
      "editable",
      "read_only",
    ]);
    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[0]).toContain("wi.id=o.workflow_instance_id");
    expect(harness.queries[0]).toContain("wi.order_id=o.id");
    expect(harness.queries[0]).not.toContain("workflow_step_fields");
  });

  it("does not consult frozen or live field tables for a truly unbound legacy order", async () => {
    harness.contexts.set("legacy", context("", false));

    const result = await loadBatchTrackingActionPolicy({
      db: database(),
      organizationId: "org-1",
      orders: [{ orderId: "legacy", orderNumber: "SO-LEGACY" }],
      fieldKey: "tracking_milestone",
    });

    expect(result.batch).toMatchObject({
      status: "legacy_fallback",
      editable: false,
      legacyFallbackOrderIds: ["legacy"],
    });
    expect(harness.queries).toHaveLength(0);
  });

  it("fails closed when the order-bound snapshot places the field under another module", async () => {
    harness.contexts.set("order-1", context("tracking"));
    harness.fields.set("order-1", [trackingField("customs")]);

    const result = await loadBatchTrackingActionPolicy({
      db: database(),
      organizationId: "org-1",
      orders: [{ orderId: "order-1", orderNumber: "SO-BAD" }],
      fieldKey: "tracking_milestone",
    });

    expect(result.batch).toMatchObject({
      status: "invalid",
      configurationValid: false,
      editable: false,
      invalidOrderIds: ["order-1"],
    });
    expect(result.batch.reason).toContain("错误模块");
  });

  it("deduplicates mounted order ids before loading policies", async () => {
    harness.contexts.set("order-1", context("tracking"));
    harness.fields.set("order-1", [trackingField()]);

    const result = await loadBatchTrackingActionPolicy({
      db: database(),
      organizationId: "org-1",
      orders: [
        { orderId: "order-1", orderNumber: "SO-001" },
        { orderId: "order-1", orderNumber: "SO-001" },
      ],
      fieldKey: "tracking_milestone",
    });

    expect(result.orders).toHaveLength(1);
    expect(harness.queries).toHaveLength(1);
  });
});
