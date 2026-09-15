import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const gateReason = "当前处于“装车前复核”，进入“自定义装车”后开放货物配载";
  const candidate = (id: string, number: string) => ({
    order_id: id,
    order_number: number,
    business_type: "ltl",
    customer_name: "测试客户",
    cargo_names: "测试货物",
    overseas_warehouse_id: "overseas-1",
    overseas_warehouse_name: "塔什干仓",
    destination_country: "UZ",
    destination_state: null,
    destination_city: "Tashkent",
    exit_port: null,
    customs_location: null,
    package_count: 1,
    pieces: 1,
    weight_kg: 100,
    volume_cbm: 1,
    location_names: "A-01",
    cargo_ready: 1,
    has_exception: 0,
    active_dispatch: 0,
    active_batch_id: null,
    active_batch_number: null,
    operation_supervisor_user_id: "supervisor-1",
    origin_country: "CN",
    origin_state: "广东",
    origin_city: "深圳",
  });
  const candidates = [candidate("order-1", "SO-001"), candidate("order-2", "SO-002")];
  const state = { stageAvailable: false };
  const queries: string[] = [];
  const DB = {
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => {
          if (sql.includes("SELECT serial_code FROM warehouses")) return { serial_code: "01" };
          if (sql.includes("MAX(CAST(substr(batch_number")) return { next: 1 };
          if (sql.includes("WITH stock AS") && sql.includes("SELECT COUNT(*) total")) {
            return { total: candidates.length };
          }
          if (sql.includes("SELECT COUNT(*) total FROM transport_batches")) return { total: 0 };
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("SELECT o.id order_id,o.order_number,o.business_type,o.origin_country")) {
            return { results: candidates };
          }
          if (sql.includes("WITH stock AS") && sql.includes("SELECT o.id order_id") && sql.includes("LIMIT ? OFFSET ?")) {
            return { results: candidates };
          }
          return { results: [] };
        }),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
  };
  return {
    gateReason,
    candidates,
    state,
    queries,
    DB,
    gateSql: vi.fn(() => "FROZEN_LOADING_GATE"),
    requireSessionUser: vi.fn(async () => ({
      organizationId: "org-1",
      userId: "warehouse-user",
      positionCode: "WAREHOUSE",
      permissions: ["warehouse.operate"],
    })),
    loadWarehouseContext: vi.fn(async () => ({
      selected: { id: "warehouse-1", name: "深圳仓", warehouse_role: "domestic_collection" },
      selectedAccessLevel: "operator",
    })),
    requireWarehouseAssignment: vi.fn(async () => undefined),
    loadStageAccesses: vi.fn(async (_db: unknown, _org: string, orderIds: readonly string[]) =>
      orderIds.map((orderId) => ({
        orderId,
        configured: true,
        available: state.stageAvailable,
        targetStepKey: "custom_loading",
        targetStepName: "自定义装车",
        reason: state.stageAvailable ? null : gateReason,
        legacyFallback: false,
      }))),
    loadLoadingWorkflows: vi.fn(async (_org: string, orderIds: readonly string[]) =>
      orderIds.map((orderId) => ({
        orderId,
        usesFrozenSnapshot: true,
        appliesToCurrentOrFuture: true,
        fields: [],
      }))),
    loadResponsibilityRestrictions: vi.fn(async () => ({
      operation: [],
      document: [],
      configurationErrors: [],
    })),
    listResponsibilityCandidates: vi.fn(async () => [{ id: "fresh-candidate" }]),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/warehouse-context.server", () => ({ loadWarehouseContext: harness.loadWarehouseContext }));
vi.mock("../lib/warehouse-access.server", () => ({ requireWarehouseAssignment: harness.requireWarehouseAssignment }));
vi.mock("../lib/loading-consolidation-stage-gate.server", () => ({
  loadLoadingConsolidationWorkflowAccesses: harness.loadStageAccesses,
  loadingConsolidationWorkflowAccessSql: harness.gateSql,
}));
vi.mock("../lib/loading-batch-field-policy.server", () => ({
  loadLoadingBatchWorkflowOrders: harness.loadLoadingWorkflows,
}));
vi.mock("../lib/loading-document-requirements.server", () => ({
  loadOrderLoadingDocumentRequirements: vi.fn(async () => []),
}));
vi.mock("../lib/order-modules.server", () => ({
  ensureOrderModules: vi.fn(async () => undefined),
  syncOrderWorkflowSnapshot: vi.fn(async () => undefined),
}));
vi.mock("../lib/loading-manifest.server", () => ({ refreshLoadingManifest: vi.fn(async () => undefined) }));
vi.mock("../lib/batch-transport-sync.server", () => ({ synchronizeBatchTransport: vi.fn(async () => undefined) }));
vi.mock("../lib/order-exception-status.server", () => ({ synchronizeOrderExceptionStatuses: vi.fn(async () => undefined) }));
vi.mock("../lib/audit.server", () => ({ writeAudit: vi.fn(async () => undefined) }));

vi.mock("../lib/batch-responsibility.server", () => ({
  loadOrdersInitialResponsibilityRestrictions: harness.loadResponsibilityRestrictions,
}));
vi.mock("../lib/organization-assignee.server", () => ({
  listActiveOrganizationAssigneeCandidates: harness.listResponsibilityCandidates,
}));
import { action, loader } from "./warehouse.cargo-consolidation";

function createPost() {
  const body = new URLSearchParams({ intent: "create" });
  body.append("orderId", "order-1");
  body.append("orderId", "order-2");
  return new Request("http://local.test/warehouse/cargo-consolidation?warehouseId=warehouse-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function addPost() {
  return new Request("http://local.test/warehouse/cargo-consolidation?warehouseId=warehouse-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "add", batchId: "batch-1", orderId: "order-1" }),
  });
}

describe("cargo consolidation frozen loading stage gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.stageAvailable = false;
    harness.queries.length = 0;
  });

  it("rejects a forged create POST before any batch or loading-module mutation", async () => {
    const result = await action({
      request: createPost(),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      formError: `暂不能配载：SO-001：${harness.gateReason}；SO-002：${harness.gateReason}`,
    });
    expect(harness.loadStageAccesses).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      ["order-1", "order-2"],
    );
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("rejects a forged add POST through the same gate without touching the target batch", async () => {
    const result = await action({
      request: addPost(),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      formError: `暂不能配载：SO-001：${harness.gateReason}`,
    });
    expect(harness.DB.batch).not.toHaveBeenCalled();
    expect(harness.queries.some((sql) => sql.includes("FROM transport_batches WHERE id=?"))).toBe(false);
  });

  it("allows creation after the frozen loading placement becomes current", async () => {
    harness.state.stageAvailable = true;

    const result = await action({
      request: createPost(),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({ success: expect.stringContaining("已生成并提交操作主管审核") });
    expect(harness.DB.batch).toHaveBeenCalled();
    expect(harness.queries.some((sql) => sql.includes("transport_batch_approval"))).toBe(true);
  });

  it("loads the list with the same workflow decision and filter predicate", async () => {
    const result = await loader({
      request: new Request(
        "http://local.test/warehouse/cargo-consolidation?warehouseId=warehouse-1&eligibility=eligible",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(harness.gateSql).toHaveBeenCalledWith("o");
    expect(harness.queries.some((sql) => sql.includes("FROZEN_LOADING_GATE"))).toBe(true);
    expect(result.loadingStageAccesses).toEqual([
      expect.objectContaining({ orderId: "order-1", available: false, reason: harness.gateReason }),
      expect.objectContaining({ orderId: "order-2", available: false, reason: harness.gateReason }),
    ]);
    expect(harness.loadStageAccesses).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      ["order-1", "order-2"],
    );
  });
});
