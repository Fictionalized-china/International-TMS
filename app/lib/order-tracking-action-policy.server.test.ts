import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

const harness = vi.hoisted(() => ({
  context: null as LockedWorkflowStageContext | null,
  fields: [] as Array<{
    module_code: string;
    field_key: string;
    step_key: string;
    is_active: number;
    is_required: number;
  }>,
  sql: [] as string[],
  bindings: [] as unknown[][],
  loadContext: vi.fn(async () => harness.context),
}));

vi.mock("./workflow-instance-stage-gate.server", () => ({
  loadLockedWorkflowStageContext: harness.loadContext,
}));

import { loadOrderTrackingActionAccess } from "./order-tracking-action-policy.server";

function context(currentStepKey = "tracking", locked = true): LockedWorkflowStageContext {
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
    modulePlacements: [{ moduleCode: "tracking", stepKey: "tracking" }],
    fields: [],
  };
}

function field(
  fieldKey: "tracking_milestone" | "actual_exit_at",
  overrides: Partial<(typeof harness.fields)[number]> = {},
): (typeof harness.fields)[number] {
  return {
    module_code: "tracking",
    field_key: fieldKey,
    step_key: "tracking",
    is_active: 1,
    is_required: 1,
    ...overrides,
  };
}

function database(): D1Database {
  return {
    prepare(sql: string) {
      harness.sql.push(sql);
      const statement = {
        bind(...values: unknown[]) {
          harness.bindings.push(values);
          return statement;
        },
        async all() {
          return { results: harness.fields };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("ordinary-order tracking action loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.context = context();
    harness.fields = [
      field("tracking_milestone"),
      field("actual_exit_at", { is_required: 0 }),
    ];
    harness.sql.length = 0;
    harness.bindings.length = 0;
  });

  it("loads both action fields from the order-bound frozen instance in one query", async () => {
    const result = await loadOrderTrackingActionAccess({
      db: database(),
      organizationId: "org-1",
      orderId: "order-1",
      canOperate: true,
      legacyCompatibility: "deny",
    });

    expect(result.tracking_milestone).toMatchObject({
      visible: true,
      editable: true,
      required: true,
    });
    expect(result.actual_exit_at).toMatchObject({
      visible: true,
      editable: true,
      required: false,
    });
    expect(harness.loadContext).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      "order-1",
      "tracking",
    );
    expect(harness.sql).toHaveLength(1);
    expect(harness.sql[0]).toContain("wi.id=o.workflow_instance_id");
    expect(harness.sql[0]).toContain("wi.organization_id=o.organization_id");
    expect(harness.sql[0]).toContain("wi.order_id=o.id");
    expect(harness.sql[0]).toContain("f.field_key IN (?,?)");
    expect(harness.sql[0]).not.toContain("workflow_step_fields");
  });

  it("returns the shared exact-step reason before and after the field node", async () => {
    harness.context = context("customs");
    const before = await loadOrderTrackingActionAccess({
      db: database(),
      organizationId: "org-1",
      orderId: "order-1",
      canOperate: true,
      legacyCompatibility: "deny",
    });
    expect(before.actual_exit_at).toMatchObject({ visible: true, editable: false, status: "read_only" });
    expect(before.actual_exit_at.reason).toContain("进入“实际出境及运踪”后开放办理");

    harness.context = context("overseas");
    const after = await loadOrderTrackingActionAccess({
      db: database(),
      organizationId: "org-1",
      orderId: "order-1",
      canOperate: true,
      legacyCompatibility: "deny",
    });
    expect(after.tracking_milestone.reason).toContain("已结束，仅供查看");
  });

  it("fails corrupt cross-module and duplicate frozen fields closed", async () => {
    harness.fields = [
      field("tracking_milestone"),
      field("actual_exit_at"),
      field("actual_exit_at", { module_code: "customs" }),
    ];
    const result = await loadOrderTrackingActionAccess({
      db: database(),
      organizationId: "org-1",
      orderId: "order-1",
      canOperate: true,
      legacyCompatibility: "deny",
    });

    expect(result.actual_exit_at).toMatchObject({
      status: "invalid",
      configurationValid: false,
      editable: false,
    });
    expect(result.actual_exit_at.reason).toContain("错误模块");
  });

  it("keeps an editable field read-only for an unassigned or unpermitted actor", async () => {
    const result = await loadOrderTrackingActionAccess({
      db: database(),
      organizationId: "org-1",
      orderId: "order-1",
      canOperate: false,
      legacyCompatibility: "deny",
    });
    expect(result.tracking_milestone).toMatchObject({
      status: "not_authorized",
      visible: true,
      editable: false,
    });
  });

  it("does not query mutable or frozen field rows for a truly unbound legacy order", async () => {
    harness.context = context("", false);
    const result = await loadOrderTrackingActionAccess({
      db: database(),
      organizationId: "org-1",
      orderId: "legacy-order",
      canOperate: true,
      legacyCompatibility: "deny",
    });

    expect(result.tracking_milestone).toMatchObject({
      status: "legacy_fallback",
      visible: false,
      editable: false,
    });
    expect(result.actual_exit_at).toMatchObject({
      status: "legacy_fallback",
      visible: false,
      editable: false,
    });
    expect(harness.sql).toHaveLength(0);
  });
});
