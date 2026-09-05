import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowFields = vi.hoisted(() => ({
  missing: [] as Array<{ label: string }>,
}));

vi.mock("./workflow-fields.server", () => ({
  missingRequiredModuleFields: vi.fn(async () => workflowFields.missing),
}));
vi.mock("./business-workflow.server", () => ({
  syncOrderBusinessWorkflow: vi.fn(),
}));

import {
  loadConfiguredReviewModuleState,
  loadOrderReviewFinalizationGate,
  type OrderReviewView,
} from "./order-review.server";

function review(
  overrides: Partial<OrderReviewView> = {},
): OrderReviewView {
  return {
    snapshotId: "snapshot-1",
    revision: 1,
    generatedAt: "2026-09-05T00:00:00.000Z",
    generatedBy: "财务会计",
    completionStatus: "completed_settled",
    completionLabel: "已完成并结清",
    timing: {
      orderAt: null,
      pickupAt: null,
      inboundAt: null,
      loadingAt: null,
      outboundAt: null,
      overseasArrivalAt: null,
      pickupCompletedAt: null,
    },
    cargo: {
      plannedPieces: 0,
      plannedWeightKg: 0,
      plannedVolumeCbm: 0,
      actualPieces: 0,
      actualWeightKg: 0,
      actualVolumeCbm: 0,
      loadedPieces: 0,
      loadedWeightKg: 0,
      loadedVolumeCbm: 0,
    },
    finance: [],
    exceptions: {
      cargoDifferenceCount: 0,
      maxCargoDifferencePercent: 0,
      openWarehouseExceptionCount: 0,
      delayDays: 0,
      costAdjustmentCount: 0,
      customerDisputeSummary: null,
    },
    people: {
      salesperson: null,
      mainOperator: null,
      warehouseHandler: null,
      financeHandler: null,
    },
    blockers: [],
    pickupComplete: true,
    pickupRequired: true,
    customerDisputeSummary: null,
    reviewConclusion: "确认完成",
    improvementNotes: null,
    ...overrides,
  };
}

function dbWithPendingModules(
  rows: Array<{ module_code: string; module_name: string }>,
) {
  return {
    prepare(sql: string) {
      expect(sql).toContain("workflow_instance_module_states");
      return {
        bind() {
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("order review finalization gate", () => {
  beforeEach(() => {
    workflowFields.missing = [];
  });

  it("blocks finalization using pending required modules from the frozen instance", async () => {
    const result = await loadOrderReviewFinalizationGate(
      dbWithPendingModules([
        { module_code: "customs", module_name: "报关与文件" },
      ]),
      "organization-1",
      "order-1",
      review(),
    );

    expect(result).toEqual({
      allowed: false,
      reason: "当前工作流仍有必办模块未完成：报关与文件",
    });
  });

  it("allows explicit archive with truthful optional unsettled balances", async () => {
    await expect(loadOrderReviewFinalizationGate(
      dbWithPendingModules([]),
      "organization-1",
      "order-1",
      review({ completionStatus: "business_complete_unsettled" }),
    )).resolves.toEqual({ allowed: true, reason: null });
  });

  it("blocks missing required review fields before evaluating completion", async () => {
    workflowFields.missing = [{ label: "复盘结论" }];
    const DB = { prepare: vi.fn() } as unknown as D1Database;

    await expect(loadOrderReviewFinalizationGate(
      DB,
      "organization-1",
      "order-1",
      review(),
    )).resolves.toEqual({
      allowed: false,
      reason: "请先补齐当前模板要求的字段：复盘结论",
    });
  });

  it("derives review blocker flags from the frozen module state with a legacy fallback", async () => {
    const dbForRow = (row: Record<string, unknown>) => ({
      prepare(sql: string) {
        expect(sql).toContain("workflow_instance_module_states");
        return {
          bind() {
            return { async first() { return row; } };
          },
        };
      },
    }) as unknown as D1Database;

    await expect(loadConfiguredReviewModuleState(
      dbForRow({
        workflow_instance_id: "instance-1",
        stored_enabled: 0,
        stored_required: 1,
        status: "in_progress",
        blocking_reason: null,
        configured_count: 1,
        configured_required: 0,
      }),
      "organization-1",
      "order-1",
      "costs",
    )).resolves.toEqual({
      enabled: 1,
      is_required: 0,
      status: "in_progress",
      blocking_reason: null,
    });

    await expect(loadConfiguredReviewModuleState(
      dbForRow({
        workflow_instance_id: null,
        stored_enabled: 1,
        stored_required: 1,
        status: "blocked",
        blocking_reason: "待核销",
        configured_count: 0,
        configured_required: 0,
      }),
      "organization-1",
      "legacy-order",
      "costs",
    )).resolves.toEqual({
      enabled: 1,
      is_required: 1,
      status: "blocked",
      blocking_reason: "待核销",
    });
  });
});
