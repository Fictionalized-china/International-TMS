import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    gates: [] as Array<Record<string, unknown>>,
    batch: { id: "batch-1", batch_number: "PZ-001", road_status: "outbound_in_transit" },
    orders: [{
      order_id: "order-1",
      order_number: "SO-001",
      overseas_warehouse_id: "warehouse-1",
      warehouse_name: "境外仓",
      warehouse_address: "塔什干",
      customs_clearance_mode: "company",
    }],
    standaloneOrder: {
      id: "order-1",
      order_number: "SO-001",
      business_type: "ftl",
      overseas_warehouse_id: "warehouse-1",
      customs_clearance_mode: "company",
      warehouse_name: "境外仓",
      warehouse_address: "塔什干",
    },
  };
  const queries: string[] = [];
  const DB = {
    prepare(sql: string) {
      queries.push(sql);
      const statement = {
        bind() { return statement; },
        async first<T>() {
          if (sql.includes("SELECT id,batch_number,road_status FROM transport_batches")) return state.batch as T;
          if (sql.includes("SELECT o.id,o.order_number,o.business_type")) return state.standaloneOrder as T;
          if (sql.includes("SELECT b.id,b.batch_number") && sql.includes("FROM transport_batch_orders")) {
            return { id: "batch-1", batch_number: "SO-001" } as T;
          }
          return null;
        },
        async all<T>() {
          if (sql.includes("SELECT DISTINCT bo.order_id")) return { results: state.orders as T[] };
          return { results: [] as T[] };
        },
      };
      return statement;
    },
    batch: vi.fn(async () => {
      throw new Error("MUTATION_BOUNDARY_REACHED");
    }),
  };
  return {
    state,
    queries,
    DB,
    loadGates: vi.fn(async () => state.gates),
    syncOrderWorkflowSnapshot: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("./overseas-inbound-policy.server", () => ({
  loadOverseasInboundCustomsGates: harness.loadGates,
}));
vi.mock("./order-modules.server", () => ({
  syncOrderWorkflowSnapshot: harness.syncOrderWorkflowSnapshot,
}));

import { confirmOverseasBatchArrival } from "./overseas-warehouse.server";

const blockedGate = {
  orderId: "order-1",
  required: true,
  cleared: false,
  blocked: true,
  configurationValid: true,
  targetStepKey: "destination_clearance",
  targetStepName: "目的地清关",
  message: "订单 SO-001 的冻结工作流要求先完成目的地清关",
};
const readyGate = { ...blockedGate, cleared: true, blocked: false, message: null };

describe("overseas arrival service shares the frozen customs gate", () => {
  beforeEach(() => {
    harness.state.gates = [];
    harness.queries.length = 0;
    vi.clearAllMocks();
  });

  it("stops a batch before mutation with the shared dynamic reason", async () => {
    harness.state.gates = [blockedGate];

    await expect(confirmOverseasBatchArrival({
      organizationId: "org-1",
      batchId: "batch-1",
      actualArrivalAt: "2026-09-06T00:00:00.000Z",
      actorUserId: "warehouse-user",
    })).rejects.toThrow(blockedGate.message);

    expect(harness.loadGates).toHaveBeenCalledWith("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-001",
      customsClearanceMode: "company",
    }]);
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("does not retain a second hard-coded batch milestone gate", async () => {
    harness.state.gates = [readyGate];

    await expect(confirmOverseasBatchArrival({
      organizationId: "org-1",
      batchId: "batch-1",
      actualArrivalAt: "2026-09-06T00:00:00.000Z",
      actorUserId: "warehouse-user",
    })).rejects.toThrow("MUTATION_BOUNDARY_REACHED");

    expect(harness.DB.batch).toHaveBeenCalledTimes(1);
    expect(harness.queries.some((sql) => sql.includes("milestone_code='customs_cleared'"))).toBe(false);
  });

  it("stops a standalone FTL order before mutation with the shared reason", async () => {
    harness.state.gates = [blockedGate];

    await expect(confirmOverseasBatchArrival({
      organizationId: "org-1",
      orderId: "order-1",
      actualArrivalAt: "2026-09-06T00:00:00.000Z",
      actorUserId: "warehouse-user",
    })).rejects.toThrow(blockedGate.message);

    expect(harness.loadGates).toHaveBeenCalledWith("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-001",
      customsClearanceMode: "company",
    }]);
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("does not retain a second hard-coded standalone milestone gate", async () => {
    harness.state.gates = [readyGate];

    await expect(confirmOverseasBatchArrival({
      organizationId: "org-1",
      orderId: "order-1",
      actualArrivalAt: "2026-09-06T00:00:00.000Z",
      actorUserId: "warehouse-user",
    })).rejects.toThrow("MUTATION_BOUNDARY_REACHED");

    expect(harness.DB.batch).toHaveBeenCalledTimes(1);
    expect(harness.queries.some((sql) => sql.includes("milestone_code='customs_cleared'"))).toBe(false);
  });
});
