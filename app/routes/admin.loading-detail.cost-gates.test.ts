import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const harness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "cs-1",
    permissions: ["order.view", "order.scope.assigned", "order.module.costs.manage"],
    positionCode: "CS",
    roleCodes: ["pos_customer_service"],
  };
  const state = {
    batchExists: true,
    approvalStatus: "approved",
    costsScopeAllowed: true,
    allocationInBatch: true,
    dispatchTotal: 2,
    dispatched: 2,
  };
  const batch = {
    id: "batch-1",
    batch_number: "PZ-20260906-001",
    batch_name: "Test PZ",
    origin_location: "深圳",
    destination_location: "塔什干",
    planned_departure_at: null,
    planned_arrival_at: null,
    actual_departure_at: null,
    status: "loading",
    road_status: "loading",
    carrier_id: null,
    warehouse_id: null,
    border_port: null,
    customs_location: null,
    transit_location: null,
    route_notes: null,
    notes: null,
    overseas_carrier_name: null,
    overseas_vehicle_type: null,
    overseas_vehicle_count: 0,
    overseas_vehicle_plate: null,
    overseas_driver_name: null,
    overseas_driver_phone: null,
    approval_status: "approved",
    operation_supervisor_user_id: "supervisor-1",
    operation_assignee_user_id: "operation-1",
    document_assignee_user_id: "document-1",
    responsibility_revision: "revision-1",
    submitted_at: "2026-09-06T00:00:00.000Z",
    approved_at: "2026-09-06T00:05:00.000Z",
    carrier_name: null,
    warehouse_name: null,
    operation_supervisor_name: "主管",
    operation_assignee_name: "操作",
    document_assignee_name: "单证",
  };
  const DB = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes("LEFT JOIN users supervisor"))
            return state.batchExists ? { ...batch, approval_status: state.approvalStatus } : null;
          if (sql.includes("FROM transport_batches b WHERE b.id=?"))
            return state.batchExists ? batch : null;
          if (sql.startsWith("SELECT batch_number,approval_status"))
            return state.batchExists ? {
              batch_number: batch.batch_number,
              approval_status: state.approvalStatus,
              operation_supervisor_user_id: batch.operation_supervisor_user_id,
              operation_assignee_user_id: batch.operation_assignee_user_id,
              document_assignee_user_id: batch.document_assignee_user_id,
              responsibility_revision: batch.responsibility_revision,
              actual_departure_at: batch.actual_departure_at,
              road_status: batch.road_status,
            } : null;
          if (sql.includes("FROM transport_batches cost_scope_batch"))
            return state.costsScopeAllowed ? { allowed: 1 } : null;
          if (sql.includes("FROM transport_cost_allocations") && sql.includes("batch_id=?"))
            return state.allocationInBatch ? { id: "allocation-1" } : null;
          if (sql.includes("COUNT(*) total") && sql.includes("warehouse_dispatches"))
            return { total: state.dispatchTotal, dispatched: state.dispatched };
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    })),
  };
  return {
    current,
    state,
    DB,
    requireSessionUser: vi.fn(async () => current),
    createCostAllocation: vi.fn(async () => "allocation-1"),
    updateCostAllocation: vi.fn(async () => undefined),
    confirmCostAllocation: vi.fn(async () => undefined),
    writeAudit: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/audit.server", () => ({ writeAudit: harness.writeAudit }));
vi.mock("../lib/cost-allocation.server", () => ({
  loadCostAllocations: vi.fn(async () => []),
  createCostAllocation: harness.createCostAllocation,
  updateCostAllocation: harness.updateCostAllocation,
  confirmCostAllocation: harness.confirmCostAllocation,
}));

import { action, CostAllocationSection, loader } from "./admin.loading-detail";

function post(intent: string, values: Record<string, string> = {}) {
  const body = new URLSearchParams({ intent, ...values });
  return new Request("http://local.test/admin/loading/batch-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("PZ cost allocation gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.batchExists = true;
    harness.state.approvalStatus = "approved";
    harness.state.costsScopeAllowed = true;
    harness.state.allocationInBatch = true;
    harness.state.dispatchTotal = 2;
    harness.state.dispatched = 2;
    harness.current.permissions = [
      "order.view",
      "order.scope.assigned",
      "order.module.costs.manage",
    ];
  });

  it("keeps the real loader read-only when frozen cost responsibility is split", async () => {
    harness.current.permissions.push("transport.batch.assigned.view");
    harness.state.costsScopeAllowed = false;
    const result = await loader({
      request: new Request("http://local.test/admin/loading/batch-1"),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never);

    expect(result.canManageBatchCosts).toBe(false);
    expect(harness.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining("FROM transport_batches cost_scope_batch"),
    );
  });

  it("renders the loader-aligned read-only reason inside the cost workbench", () => {
    const reason = "当前账号不是全部挂载订单共同的冻结费用负责人，本区只读。";
    const markup = renderToStaticMarkup(CostAllocationSection({
      allocations: [],
      busy: false,
      manage: false,
      blockedReason: reason,
    }));

    expect(markup).toContain(reason);
    expect(markup).toContain('class="alert warning"');
    expect(markup).not.toContain('name="intent"');
  });

  it("rejects a forged cost POST before PZ approval", async () => {
    harness.state.approvalStatus = "submitted";
    await expect(action({
      request: post("create_cost_allocation"),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).resolves.toEqual({
      formError: "配载单尚未审核通过，费用分摊暂不可办理",
    });
    expect(harness.createCostAllocation).not.toHaveBeenCalled();
  });

  it("rejects split customer-service ownership for an entire batch mutation", async () => {
    harness.state.costsScopeAllowed = false;
    await expect(action({
      request: post("confirm_cost_allocation", { allocationId: "allocation-1" }),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).resolves.toEqual({
      formError: "整批费用分摊仅允许由全部挂载订单共同的冻结费用负责人办理；当前账号的负责范围不完整",
    });
    expect(harness.confirmCostAllocation).not.toHaveBeenCalled();
  });

  it("rejects a forged cost POST until every mounted order is dispatched", async () => {
    harness.state.dispatched = 1;
    await expect(action({
      request: post("update_cost_allocation", {
        allocationId: "allocation-1",
        method: "equal",
      }),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).resolves.toEqual({
      formError: "全部挂载订单完成装车出库后，才能办理整批费用分摊（当前 1/2 票）",
    });
    expect(harness.updateCostAllocation).not.toHaveBeenCalled();
  });

  it("does not mutate an allocation belonging to another batch", async () => {
    harness.state.allocationInBatch = false;
    await expect(action({
      request: post("confirm_cost_allocation", { allocationId: "other-allocation" }),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).resolves.toEqual({
      formError: "费用分摊记录不存在或不属于当前配载单",
    });
    expect(harness.confirmCostAllocation).not.toHaveBeenCalled();
  });

  it("allows a cost intent after approval, dispatch, and whole-batch ownership", async () => {
    await expect(action({
      request: post("create_cost_allocation", {
        chargeCode: "FREIGHT",
        counterpartyName: "承运商",
        totalAmount: "100",
        currency: "CNY",
        exchangeRate: "1",
        method: "equal",
      }),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).resolves.toEqual({
      success: "分摊草稿已生成；请逐票检查后再确认入账",
    });
    expect(harness.createCostAllocation).toHaveBeenCalledTimes(1);
  });
});
