import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { BatchTrackingActionPolicy } from "../lib/batch-tracking-action-policy";

const harness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "operation-1",
    permissions: [
      "order.view",
      "order.scope.assigned",
      "transport.batch.assigned.view",
      "order.module.tracking.manage",
      "order.module.exceptions.manage",
    ],
    positionCode: "OPERATION",
    roleCodes: ["pos_operation"],
  };
  const state = {
    ownerUserId: "operation-1",
    milestoneStatus: "editable" as BatchTrackingActionPolicy["status"],
    milestoneReason: null as string | null,
    milestoneParticipants: ["order-1", "order-2"],
    exitStatus: "editable" as BatchTrackingActionPolicy["status"],
    exitReason: null as string | null,
    exitParticipants: ["order-1", "order-2"],
  };
  const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
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
    warehouse_id: "warehouse-1",
    border_port: "PORT-1",
    customs_location: "深圳",
    transit_location: null,
    route_notes: null,
    notes: null,
    overseas_carrier_name: "境外承运商",
    overseas_vehicle_type: "卡车",
    overseas_vehicle_count: 1,
    overseas_vehicle_plate: "OUT-001",
    overseas_driver_name: "司机",
    overseas_driver_phone: "13800000000",
    approval_status: "approved",
    operation_supervisor_user_id: "supervisor-1",
    operation_assignee_user_id: "operation-1",
    document_assignee_user_id: "doc-1",
    responsibility_revision: "revision-1",
    submitted_at: "2026-09-06T00:00:00.000Z",
    approved_at: "2026-09-06T00:05:00.000Z",
    carrier_name: null,
    warehouse_name: "仓库",
    operation_supervisor_name: "主管",
    operation_assignee_name: "操作",
    document_assignee_name: "单证",
  };
  const orders = [
    {
      order_id: "order-1",
      order_number: "SO-001",
      business_type: "ltl",
      work_number: "SHP-001",
      customer_name: "客户一",
      cargo_description: "货物一",
      cargo_names: "货物一",
      pieces: 1,
      gross_weight_kg: 100,
      volume_cbm: 1,
      declared_weight_kg: 100,
      declared_volume_cbm: 1,
      inbound_at: null,
      dispatched_packages: 1,
      in_stock_packages: 0,
      overseas_warehouse_id: null,
      overseas_warehouse_name: null,
      overseas_status: null,
      overseas_arrival_at: null,
      document_assignee_user_id: "doc-1",
      customs_assignee_user_id: "doc-1",
    },
    {
      order_id: "order-2",
      order_number: "SO-002",
      business_type: "ltl",
      work_number: "SHP-002",
      customer_name: "客户二",
      cargo_description: "货物二",
      cargo_names: "货物二",
      pieces: 1,
      gross_weight_kg: 100,
      volume_cbm: 1,
      declared_weight_kg: 100,
      declared_volume_cbm: 1,
      inbound_at: null,
      dispatched_packages: 1,
      in_stock_packages: 0,
      overseas_warehouse_id: null,
      overseas_warehouse_name: null,
      overseas_status: null,
      overseas_arrival_at: null,
      document_assignee_user_id: "doc-1",
      customs_assignee_user_id: "doc-1",
    },
  ];
  const DB = {
    prepare: vi.fn((sql: string) => {
      const record = { sql, bindings: [] as unknown[] };
      prepared.push(record);
      const statement = {
        bind: vi.fn((...bindings: unknown[]) => {
          record.bindings = bindings;
          return statement;
        }),
        first: vi.fn(async () => {
          if (sql.includes("LEFT JOIN users supervisor")) return { ...batch };
          if (sql.includes("FROM transport_batches b WHERE b.id=?"))
            return { ...batch };
          if (sql.startsWith("SELECT batch_number,approval_status")) {
            return {
              batch_number: batch.batch_number,
              approval_status: "approved",
              operation_supervisor_user_id: "supervisor-1",
              operation_assignee_user_id: state.ownerUserId,
              document_assignee_user_id: "doc-1",
              responsibility_revision: "revision-1",
              actual_departure_at: null,
              road_status: "loading",
            };
          }
          if (sql.includes("COUNT(*) total") && sql.includes("warehouse_dispatches"))
            return { total: 2, dispatched: 2 };
          if (sql.includes("FROM warehouse_dispatches d JOIN warehouse_dispatch_items"))
            return { ready: 1 };
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("COALESCE((SELECT s.shipment_number"))
            return { results: orders };
          if (sql.includes("SELECT bo.order_id,o.order_number") && sql.includes("transport_batch_orders"))
            return { results: orders.map((order) => ({ order_id: order.order_id, order_number: order.order_number })) };
          if (sql.includes("WITH batch_orders AS")) {
            return {
              results: orders.flatMap((order) => [
                "tracking_milestone",
                "tracking_event_at",
                "tracking_location",
                "tracking_vehicle",
                "tracking_notes",
                "visible_to_customer",
                "actual_exit_at",
              ].map((fieldKey) => ({
                order_id: order.order_id,
                business_type: "ltl",
                bound_workflow_instance_id: `workflow-${order.order_id}`,
                matched_workflow_instance_id: `workflow-${order.order_id}`,
                module_code: "tracking",
                enabled: 1,
                module_required: 1,
                field_key: fieldKey,
                label: fieldKey,
                is_active: 1,
                field_required: ["tracking_milestone", "tracking_event_at", "tracking_location", "visible_to_customer", "actual_exit_at"].includes(fieldKey) ? 1 : 0,
              }))),
            };
          }
          return { results: [] };
        }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
  };
  return {
    current,
    state,
    batch,
    orders,
    DB,
    prepared,
    requireSessionUser: vi.fn(async () => current),
    loadBatchTrackingActionPolicy: vi.fn(),
    writeAudit: vi.fn(async () => undefined),
  };
});

function batchPolicy(
  status: BatchTrackingActionPolicy["status"],
  reason: string | null,
  participatingOrderIds: string[],
): BatchTrackingActionPolicy {
  return {
    status,
    configurationValid: status !== "invalid",
    visible: !["hidden", "legacy_fallback"].includes(status),
    editable: status === "editable",
    participatingOrderIds,
    editableOrderIds: status === "editable" ? participatingOrderIds : [],
    readOnlyOrderIds: status === "read_only" ? participatingOrderIds : [],
    hiddenOrderIds: status === "hidden" ? ["order-1", "order-2"] : [],
    invalidOrderIds: status === "invalid" ? ["order-1"] : [],
    legacyFallbackOrderIds: status === "legacy_fallback" ? ["order-1"] : [],
    reason,
  };
}

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/audit.server", () => ({ writeAudit: harness.writeAudit }));
vi.mock("../lib/batch-tracking-action-policy.server", () => ({
  loadBatchTrackingActionPolicy: harness.loadBatchTrackingActionPolicy,
}));
vi.mock("../lib/batch-tracking.server", () => ({
  getBatchOrderIds: vi.fn(async () => ["order-1", "order-2"]),
  getBatchMainVehiclePlate: vi.fn(async () => "粤B001"),
  validateBatchTrackingRequiredPrevious: vi.fn(async () => null),
  syncTrackingModuleStatusForOrder: vi.fn(async () => undefined),
  syncBatchRoadStatusFromTracking: vi.fn(async () => undefined),
}));
vi.mock("../lib/batch-exceptions.server", () => ({
  createBatchException: vi.fn(),
  listBatchExceptionPackages: vi.fn(async () => []),
  listBatchExceptions: vi.fn(async () => []),
  listBlockingBatchExceptions: vi.fn(async () => []),
  progressBatchException: vi.fn(),
  resolveBatchException: vi.fn(),
}));
vi.mock("../lib/loading-batch-customs-access.server", () => ({
  loadBatchCustomsAccess: vi.fn(async () => ({
    total: 2,
    dispatched: 2,
    allDispatched: true,
    orders: harness.orders.map((order) => ({ orderId: order.order_id, dispatched: true })),
  })),
}));
vi.mock("../lib/loading-document-requirements.server", () => ({
  loadOrderLoadingDocumentRequirements: vi.fn(async () => []),
}));
vi.mock("../lib/order-readiness.server", () => ({
  checkOrderDeparture: vi.fn(async () => ({ ready: true, reasons: [] })),
  checkOrderPreDepartureDocuments: vi.fn(async () => ({ ready: true, reasons: [] })),
}));
vi.mock("../lib/cost-allocation.server", () => ({
  loadCostAllocations: vi.fn(async () => []),
  createCostAllocation: vi.fn(),
  updateCostAllocation: vi.fn(),
  confirmCostAllocation: vi.fn(),
}));
vi.mock("../lib/business-workflow.server", () => ({
  recordWorkflowEvent: vi.fn(async () => undefined),
}));

import {
  action,
  BatchTrackingWorkbench,
  loader,
} from "./admin.loading-detail";

function post(intent: string, values: Record<string, string> = {}) {
  return new Request("http://local.test/admin/loading/batch-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent, ...values }),
  });
}

async function runAction(intent: string, values: Record<string, string> = {}) {
  return action({
    request: post(intent, values),
    params: { batchId: "batch-1" },
    context: undefined,
  } as never);
}

describe("PZ frozen tracking route gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.prepared.length = 0;
    harness.state.ownerUserId = "operation-1";
    harness.state.milestoneStatus = "editable";
    harness.state.milestoneReason = null;
    harness.state.milestoneParticipants = ["order-1", "order-2"];
    harness.state.exitStatus = "editable";
    harness.state.exitReason = null;
    harness.state.exitParticipants = ["order-1", "order-2"];
    harness.loadBatchTrackingActionPolicy.mockImplementation(async ({ fieldKey }: { fieldKey: string }) => {
      const exit = fieldKey === "actual_exit_at";
      const status = exit ? harness.state.exitStatus : harness.state.milestoneStatus;
      const reason = exit ? harness.state.exitReason : harness.state.milestoneReason;
      const participants = exit ? harness.state.exitParticipants : harness.state.milestoneParticipants;
      return { orders: [], batch: batchPolicy(status, reason, participants) };
    });
  });

  it("loads both frozen batch policies for the page", async () => {
    const result = await loader({
      request: new Request("http://local.test/admin/loading/batch-1"),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never);

    expect(result.trackingMilestoneAction.status).toBe("editable");
    expect(result.actualExitAction.status).toBe("editable");
    expect(harness.loadBatchTrackingActionPolicy).toHaveBeenCalledWith(expect.objectContaining({
      db: harness.DB,
      organizationId: "org-1",
      fieldKey: "tracking_milestone",
      orders: [
        { orderId: "order-1", orderNumber: "SO-001" },
        { orderId: "order-2", orderNumber: "SO-002" },
      ],
    }));
    expect(harness.loadBatchTrackingActionPolicy).toHaveBeenCalledWith(expect.objectContaining({
      fieldKey: "actual_exit_at",
    }));
  });

  it.each([
    ["read_only", "订单 SO-002 当前尚未进入实际出境及运踪"],
    ["hidden", "挂载订单的冻结工作流均未开放该运踪字段"],
    ["invalid", "订单 SO-001 的冻结工作流实例绑定异常"],
    ["legacy_fallback", "订单 SO-001 未绑定冻结工作流"],
  ] as const)("rejects forged tracking writes when policy is %s", async (status, reason) => {
    harness.state.milestoneStatus = status;
    harness.state.milestoneReason = reason;
    harness.state.milestoneParticipants = [];

    await expect(runAction("batch_tracking_add", {
      milestoneCode: "border_arrived",
      eventAt: "2026-09-06T10:00",
      location: "口岸",
    })).resolves.toEqual({ formError: reason });

    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("uses the actual-exit frozen policy for forged exit confirmation", async () => {
    harness.state.exitStatus = "read_only";
    harness.state.exitReason = "订单 SO-002 的实际出境节点已经结束，仅供查看";
    harness.state.exitParticipants = [];

    await expect(runAction("exit_confirm", {
      actualExitAt: "2026-09-06T10:00",
      exitPort: "PORT-1",
      exitVehiclePlate: "粤B001",
    })).resolves.toEqual({ formError: harness.state.exitReason });
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("rejects the previous operation owner before resolving mutation policy", async () => {
    harness.state.ownerUserId = "operation-2";

    await expect(runAction("batch_tracking_add")).resolves.toEqual({
      formError: "本配载单的运踪与异常只允许已指派的整单操作负责人办理",
    });
    expect(harness.loadBatchTrackingActionPolicy).not.toHaveBeenCalled();
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("writes only loader-approved participating orders and ignores a forged orderId", async () => {
    harness.state.milestoneParticipants = ["order-1"];

    await expect(runAction("batch_tracking_add", {
      orderId: "forged-order",
      milestoneCode: "border_arrived",
      eventAt: "2026-09-06T10:00",
      location: "口岸",
      visibleToCustomer: "on",
    })).resolves.toMatchObject({ success: expect.stringContaining("1 票订单") });

    const insert = harness.prepared.find((item) =>
      item.sql.includes("INSERT INTO order_tracking_milestones"),
    );
    expect(insert?.bindings).toContain("order-1");
    expect(insert?.bindings).not.toContain("order-2");
    expect(insert?.bindings).not.toContain("forged-order");
    expect(harness.loadBatchTrackingActionPolicy).toHaveBeenCalledWith(expect.objectContaining({
      orders: [
        { orderId: "order-1", orderNumber: "SO-001" },
        { orderId: "order-2", orderNumber: "SO-002" },
      ],
    }));
  });

  it("writes optional-node settings only to frozen-policy participants", async () => {
    harness.state.milestoneParticipants = ["order-1"];

    await expect(runAction("batch_tracking_option_toggle", {
      optionCode: "transloaded",
      enable: "on",
    })).resolves.toMatchObject({ success: expect.stringContaining("1 票订单") });

    const update = harness.prepared.find((item) =>
      item.sql.includes("UPDATE transport_orders SET requires_transloading"),
    );
    expect(update?.bindings).toContain("order-1");
    expect(update?.bindings).not.toContain("order-2");
    expect(update?.sql).toContain("EXISTS(SELECT 1 FROM transport_batch_orders");
    expect(update?.bindings).toContain("batch-1");
  });

  it("writes actual-exit order state only to frozen-policy participants", async () => {
    harness.state.exitParticipants = ["order-1"];

    await expect(runAction("exit_confirm", {
      actualExitAt: "2026-09-06T10:00",
    })).resolves.toMatchObject({ success: expect.stringContaining("出境确认完成") });

    const participantWrites = harness.prepared.filter((item) => [
      "UPDATE transport_batch_orders",
      "UPDATE order_module_instances",
      "UPDATE order_cargo_packages",
      "INSERT INTO order_tasks",
      "UPDATE shipments",
      "INSERT INTO shipment_events",
    ].some((fragment) => item.sql.includes(fragment)));
    expect(participantWrites.length).toBeGreaterThanOrEqual(6);
    for (const write of participantWrites) {
      expect(write.bindings).toContain("order-1");
      expect(write.bindings).not.toContain("order-2");
    }
    expect(harness.prepared.find((item) =>
      item.sql.includes("INSERT INTO order_tracking_milestones"),
    )?.bindings).toContain("order-1");
  });

  it("surfaces the exact loader reason and removes write forms when the batch is read-only", () => {
    const reason = "订单 SO-002 当前尚未进入实际出境及运踪";
    const readonly = batchPolicy("read_only", reason, ["order-1", "order-2"]);
    const workbench = BatchTrackingWorkbench({
      batchId: "batch-1",
      batchNumber: "PZ-001",
      orders: harness.orders,
      visibleOrders: harness.orders,
      orderPagination: { page: 1, pageCount: 1, pageSize: 10, total: 2 },
      trackingMilestones: [],
      trackingFlags: [],
      workflowPolicies: harness.orders.flatMap((order) => [{
        orderId: order.order_id,
        businessType: "ltl",
        moduleCode: "tracking" as const,
        enabled: true,
        required: true,
        fields: [
          { fieldKey: "tracking_milestone", isActive: true, isRequired: true },
          { fieldKey: "actual_exit_at", isActive: true, isRequired: true },
        ],
      }]),
      batchVehiclePlate: "粤B001",
      overseasVehiclePlate: null,
      borderPort: "PORT-1",
      customsLocation: "深圳",
      busy: false,
      manage: true,
      milestoneAction: readonly,
      actualExitAction: readonly,
      warehouseReady: true,
      documentGateReady: true,
      exitConfirmed: false,
      canConfirmExit: true,
      exitBlockers: [],
      borderPorts: [],
      documentsHref: "?tab=documents",
    } as never);
    const markup = renderToStaticMarkup(createElement(
      MemoryRouter,
      { initialEntries: ["/admin/loading/batch-1?tab=tracking"] },
      workbench,
    ));

    expect(markup).toContain(reason);
    expect(markup).not.toContain('name="intent" value="batch_tracking_add"');
    expect(markup).not.toContain('name="intent" value="exit_confirm"');
  });
});
