import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "doc-1",
    permissions: [
      "order.view",
      "order.scope.assigned",
      "transport.batch.assigned.view",
      "order.module.customs.manage",
    ],
    positionCode: "DOC",
    roleCodes: ["pos_doc"],
  };
  const state = {
    declarationAllowed: false,
    releaseAllowed: false,
    declarationReason: "当前处于装车出库，尚未进入报关与出境",
    releaseReason: "当前处于装车出库，尚未进入报关与出境",
  };
  const preparedSql: string[] = [];
  const DB = {
    prepare: vi.fn((sql: string) => {
      preparedSql.push(sql);
      return {
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.includes("FROM transport_batches b WHERE b.id=?")) {
              return {
                id: "batch-1",
                batch_number: "PZ-20260906-001",
                status: "loading",
                road_status: "loading",
                border_port: null,
                customs_location: null,
                route_notes: null,
                warehouse_id: "warehouse-1",
                overseas_carrier_name: null,
                overseas_vehicle_type: null,
                overseas_vehicle_count: 0,
                overseas_vehicle_plate: null,
                overseas_driver_name: null,
                overseas_driver_phone: null,
              };
            }
            if (sql.startsWith("SELECT batch_number,approval_status")) {
              return {
                batch_number: "PZ-20260906-001",
                approval_status: "approved",
                operation_supervisor_user_id: "supervisor-1",
                operation_assignee_user_id: "operation-1",
                document_assignee_user_id: "doc-1",
                responsibility_revision: "revision-1",
                actual_departure_at: null,
                road_status: "loading",
              };
            }
            return null;
          }),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      };
    }),
  };
  return {
    current,
    state,
    DB,
    preparedSql,
    requireSessionUser: vi.fn(async () => current),
    loadBatchCustomsAccess: vi.fn(async () => ({
      total: 1,
      dispatched: state.declarationReason.includes("全部有效挂载订单") ? 0 : 1,
      allDispatched: !state.declarationReason.includes("全部有效挂载订单"),
      orders: [{
        orderId: "order-1",
        businessType: "ltl",
        dispatched: !state.declarationReason.includes("全部有效挂载订单"),
        canManageDeclarations: state.declarationAllowed,
        canRelease: state.releaseAllowed,
        declarationAccess: {
          visible: true,
          stageReady: state.declarationAllowed,
          targetStepKey: "outbound_transport",
          targetStepName: "报关与出境",
          reason: state.declarationAllowed ? null : state.declarationReason,
        },
        releaseAccess: {
          visible: true,
          stageReady: state.releaseAllowed,
          targetStepKey: "outbound_transport",
          targetStepName: "报关与出境",
          reason: state.releaseAllowed ? null : state.releaseReason,
        },
      }],
    })),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/loading-batch-customs-access.server", () => ({
  loadBatchCustomsAccess: harness.loadBatchCustomsAccess,
}));

import { action } from "./admin.loading-detail";

function post(values: Record<string, string> = {}) {
  const body = new URLSearchParams({
    intent: "batch_order_customs_declaration_save",
    orderId: "order-1",
    ...values,
  });
  return new Request("http://local.test/admin/loading/batch-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function runAction(values: Record<string, string> = {}) {
  return action({
    request: post(values),
    params: { batchId: "batch-1" },
    context: undefined,
  } as never);
}

describe("PZ customs mutation route gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.preparedSql.length = 0;
    harness.state.declarationAllowed = false;
    harness.state.releaseAllowed = false;
    harness.state.declarationReason = "当前处于装车出库，尚未进入报关与出境";
    harness.state.releaseReason = harness.state.declarationReason;
  });

  it.each([
    ["前置节点", "当前处于装车出库，尚未进入报关与出境"],
    ["部分出库", "全部有效挂载订单完成装车出库后，才开放报关申报与放行"],
    ["损坏绑定", "冻结工作流中的报关节点配置无效，报关操作已阻止"],
  ])("rejects a forged declaration POST for %s", async (_label, reason) => {
    harness.state.declarationReason = reason;

    await expect(runAction()).resolves.toEqual({ formError: reason });

    expect(harness.loadBatchCustomsAccess).toHaveBeenCalledWith(
      harness.DB, "org-1", "batch-1",
    );
    expect(harness.preparedSql.some((sql) =>
      sql.includes("INSERT INTO order_customs_declarations") ||
      sql.includes("UPDATE order_customs_declarations"),
    )).toBe(false);
  });

  it("requires an existing declaration before the release capability can be used", async () => {
    harness.state.releaseAllowed = true;

    await expect(runAction({ releaseDeclaration: "1" })).resolves.toEqual({
      formError: "确认放行必须选择当前订单已有的有效报关单",
    });
  });

  it("passes the physical gate after dispatch and at the frozen customs node", async () => {
    harness.state.declarationAllowed = true;

    await expect(runAction()).resolves.toEqual({
      formError: "当前订单工作流未启用报关模块",
    });
    expect(harness.loadBatchCustomsAccess).toHaveBeenCalledTimes(1);
  });
});
