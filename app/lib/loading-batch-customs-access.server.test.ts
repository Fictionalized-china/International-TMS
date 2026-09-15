import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

const harness = vi.hoisted(() => ({
  rows: [] as Array<{
    order_id: string;
    business_type: string;
    dispatched: number;
  }>,
  contexts: new Map<string, unknown>(),
  sql: [] as string[],
  loadLockedWorkflowStageContext: vi.fn(
    async (_db: unknown, _organizationId: string, orderId: string) =>
      harness.contexts.get(orderId),
  ),
}));

vi.mock("./workflow-instance-stage-gate.server", () => ({
  loadLockedWorkflowStageContext: harness.loadLockedWorkflowStageContext,
}));

import { loadBatchCustomsAccess } from "./loading-batch-customs-access.server";
import { batchOrderCustomsReleaseActionAvailable } from "./loading-batch-customs-access";

function frozenCustomsContext(
  currentStepKey: string | null,
  overrides: Partial<LockedWorkflowStageContext> = {},
): LockedWorkflowStageContext {
  return {
    locked: true,
    currentStepKey,
    steps: [
      { stepKey: "port_loading", stepName: "装车出库", sortOrder: 70 },
      { stepKey: "outbound_transport", stepName: "报关与出境", sortOrder: 80 },
      { stepKey: "customer_delivery", stepName: "客户交付", sortOrder: 90 },
    ],
    modulePlacements: [
      { moduleCode: "customs", stepKey: "outbound_transport" },
    ],
    fields: [
      {
        moduleCode: "customs",
        fieldKey: "customs_declarations",
        stepKey: "outbound_transport",
        isActive: true,
        isRequired: true,
      },
      {
        moduleCode: "customs",
        fieldKey: "declaration_number",
        stepKey: "outbound_transport",
        isActive: true,
        isRequired: true,
      },
      {
        moduleCode: "customs",
        fieldKey: "customs_release",
        stepKey: "outbound_transport",
        isActive: true,
        isRequired: true,
      },
    ],
    ...overrides,
  };
}

function database() {
  return {
    prepare(sql: string) {
      harness.sql.push(sql);
      return {
        bind() {
          return {
            async all() {
              return { results: harness.rows };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("loading batch customs access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.rows = [];
    harness.contexts.clear();
    harness.sql.length = 0;
  });

  it("does not expose a release action until frozen required customs files are ready", () => {
    const base = {
      manageCustoms: true,
      customsEnabled: true,
      releaseFieldVisible: true,
      ownsCustoms: true,
      workflowCanRelease: true,
    };

    expect(batchOrderCustomsReleaseActionAvailable({
      ...base,
      customsFilesReady: false,
    })).toBe(false);
    expect(batchOrderCustomsReleaseActionAvailable({
      ...base,
      customsFilesReady: true,
    })).toBe(true);
    expect(batchOrderCustomsReleaseActionAvailable({
      ...base,
      ownsCustoms: false,
      customsFilesReady: true,
    })).toBe(false);
  });

  it("keeps a fully dispatched order read-only before its frozen customs stage", async () => {
    harness.rows = [{ order_id: "ltl-1", business_type: "ltl", dispatched: 1 }];
    harness.contexts.set("ltl-1", frozenCustomsContext("port_loading"));

    const result = await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(result.allDispatched).toBe(true);
    expect(result.orders[0].canManageDeclarations).toBe(false);
    expect(result.orders[0].canRelease).toBe(false);
    expect(result.orders[0].declarationAccess.reason).toContain("装车出库");
    expect(result.orders[0].declarationAccess.reason).toContain("报关与出境");
  });
  it("returns to read-only after the order has left its frozen customs stage", async () => {
    harness.rows = [{ order_id: "ftl-after", business_type: "ftl", dispatched: 1 }];
    harness.contexts.set("ftl-after", frozenCustomsContext("customer_delivery"));

    const result = await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(result.allDispatched).toBe(true);
    expect(result.orders[0].canManageDeclarations).toBe(false);
    expect(result.orders[0].canRelease).toBe(false);
    expect(result.orders[0].declarationAccess.reason).toContain("客户交付");
    expect(result.orders[0].declarationAccess.reason).toContain("报关与出境");
  });

  it("uses each frozen workflow stage even when zero of N orders has dispatched", async () => {
    harness.rows = [
      { order_id: "ltl-1", business_type: "ltl", dispatched: 0 },
      { order_id: "ltl-2", business_type: "ltl", dispatched: 0 },
    ];
    harness.contexts.set("ltl-1", frozenCustomsContext("outbound_transport"));
    harness.contexts.set("ltl-2", frozenCustomsContext("outbound_transport"));

    const result = await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(result).toMatchObject({ total: 2, dispatched: 0, allDispatched: false });
    expect(result.orders.every((order) => order.dispatched === false)).toBe(true);
    expect(result.orders.every((order) => order.canManageDeclarations)).toBe(true);
    expect(result.orders.every((order) => order.canRelease)).toBe(true);
    expect(result.orders.every((order) => order.declarationAccess.reason === null)).toBe(true);
    expect(result.orders.every((order) => order.releaseAccess.reason === null)).toBe(true);
  });

  it("fails closed when a non-null frozen binding cannot resolve its exact instance", async () => {
    harness.rows = [{ order_id: "ltl-broken", business_type: "ltl", dispatched: 1 }];
    harness.contexts.set("ltl-broken", frozenCustomsContext(null, {
      steps: [],
      modulePlacements: [],
      fields: [],
    }));

    const result = await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(result.orders[0].canManageDeclarations).toBe(false);
    expect(result.orders[0].canRelease).toBe(false);
    expect(result.orders[0].declarationAccess.reason).toContain("未配置");
  });

  it("fails closed when the frozen workflow hides customs declaration and release", async () => {
    const hidden = frozenCustomsContext("outbound_transport");
    harness.rows = [{ order_id: "ltl-hidden", business_type: "ltl", dispatched: 1 }];
    harness.contexts.set("ltl-hidden", {
      ...hidden,
      fields: hidden.fields.map((field) =>
        field.fieldKey === "customs_declarations" || field.fieldKey === "customs_release"
          ? { ...field, isActive: false }
          : field,
      ),
    });

    const result = await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(result.orders[0].canManageDeclarations).toBe(false);
    expect(result.orders[0].canRelease).toBe(false);
    expect(result.orders[0].declarationAccess).toMatchObject({
      visible: false,
      stageReady: false,
    });
    expect(result.orders[0].releaseAccess).toMatchObject({
      visible: false,
      stageReady: false,
    });
    expect(result.orders[0].declarationAccess.reason).toContain("已隐藏");
    expect(result.orders[0].releaseAccess.reason).toContain("已隐藏");
  });

  it("evaluates heterogeneous FTL and LTL orders against each order's own frozen customs stage", async () => {
    harness.rows = [
      { order_id: "ftl-1", business_type: "ftl", dispatched: 1 },
      { order_id: "ltl-1", business_type: "ltl", dispatched: 0 },
    ];
    harness.contexts.set("ftl-1", frozenCustomsContext("outbound_transport"));
    harness.contexts.set("ltl-1", frozenCustomsContext("customs_checkpoint", {
      steps: [
        { stepKey: "port_loading", stepName: "装车出库", sortOrder: 70 },
        { stepKey: "customs_checkpoint", stepName: "拼车专用报关", sortOrder: 75 },
        { stepKey: "outbound_transport", stepName: "出境运输", sortOrder: 80 },
      ],
      modulePlacements: [
        { moduleCode: "customs", stepKey: "customs_checkpoint" },
      ],
      fields: [
        {
          moduleCode: "customs",
          fieldKey: "customs_declarations",
          stepKey: "customs_checkpoint",
          isActive: true,
          isRequired: true,
        },
        {
          moduleCode: "customs",
          fieldKey: "declaration_number",
          stepKey: "customs_checkpoint",
          isActive: true,
          isRequired: true,
        },
        {
          moduleCode: "customs",
          fieldKey: "customs_release",
          stepKey: "customs_checkpoint",
          isActive: true,
          isRequired: true,
        },
      ],
    }));

    const result = await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(result).toMatchObject({ total: 2, dispatched: 1, allDispatched: false });
    expect(result.orders.map((order) => ({
      businessType: order.businessType,
      dispatched: order.dispatched,
      targetStepKey: order.declarationAccess.targetStepKey,
      canManageDeclarations: order.canManageDeclarations,
      canRelease: order.canRelease,
    }))).toEqual([
      {
        businessType: "ftl",
        dispatched: true,
        targetStepKey: "outbound_transport",
        canManageDeclarations: true,
        canRelease: true,
      },
      {
        businessType: "ltl",
        dispatched: false,
        targetStepKey: "customs_checkpoint",
        canManageDeclarations: true,
        canRelease: true,
      },
    ]);
  });

  it("scopes dispatch and workflow ownership by organization and exact order", async () => {
    harness.rows = [{ order_id: "ltl-1", business_type: "ltl", dispatched: 1 }];
    harness.contexts.set("ltl-1", frozenCustomsContext("outbound_transport"));

    await loadBatchCustomsAccess(database(), "org-1", "batch-1");

    expect(harness.sql[0]).toContain("o.organization_id=bo.organization_id");
    expect(harness.sql[0]).toContain("d.organization_id=bo.organization_id");
    expect(harness.sql[0]).toContain("s.order_id=bo.order_id");
    expect(harness.sql[0]).toContain("bo.status!='removed'");
    expect(harness.loadLockedWorkflowStageContext).toHaveBeenCalledWith(
      expect.anything(), "org-1", "ltl-1", "customs",
    );
  });
});
