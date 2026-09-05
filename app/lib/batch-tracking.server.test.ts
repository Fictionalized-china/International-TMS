import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Prepared = {
    query: string;
    bindings: unknown[];
    bind: (...values: unknown[]) => Prepared;
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
  };
  const state = {
    progress: 0,
    milestones: [] as string[],
    fields: [] as Array<{
      fieldKey: string;
      isActive: boolean;
      isRequired: boolean;
    }>,
    module: {
      id: "tracking-module-1",
      status: "in_progress",
      current_step_code: "transit",
      progress_percent: 64,
    } as {
      id: string;
      status: string;
      current_step_code: string | null;
      progress_percent: number;
    } | null,
  };
  const batches: Prepared[][] = [];
  const DB = {
    prepare(query: string): Prepared {
      const statement: Prepared = {
        query,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async first<T>() {
          if (query.includes("SELECT MAX(CASE milestone_code")) {
            return { progress: state.progress } as T;
          }
          if (query.includes("FROM order_module_instances")) {
            return state.module as T | null;
          }
          return null;
        },
        async all<T>() {
          if (query.includes("FROM order_tracking_milestones")) {
            return {
              results: state.milestones.map((milestone_code) => ({ milestone_code })) as T[],
            };
          }
          return { results: [] as T[] };
        },
      };
      return statement;
    },
    async batch(statements: Prepared[]) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
  return { state, batches, DB };
});

const workflowFields = vi.hoisted(() => vi.fn());
const syncOrderWorkflowSnapshot = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("./workflow-fields.server", () => ({
  loadOrderModuleWorkflowFields: workflowFields,
}));
vi.mock("./order-modules.server", () => ({ syncOrderWorkflowSnapshot }));

import { syncTrackingModuleStatusForOrder } from "./batch-tracking.server";

describe("tracking module overseas handoff synchronization", () => {
  beforeEach(() => {
    harness.batches.length = 0;
    harness.state.progress = 0;
    harness.state.milestones = [];
    harness.state.fields = [
      { fieldKey: "actual_exit_at", isActive: true, isRequired: true },
      { fieldKey: "tracking_milestone", isActive: true, isRequired: true },
    ];
    harness.state.module = {
      id: "tracking-module-1",
      status: "in_progress",
      current_step_code: "transit",
      progress_percent: 64,
    };
    workflowFields.mockReset();
    workflowFields.mockImplementation(async () => harness.state.fields);
    syncOrderWorkflowSnapshot.mockReset();
  });

  it("completes tracking at configured customs clearance and synchronizes the next frozen step", async () => {
    harness.state.progress = 82;
    harness.state.milestones = [
      "border_arrived",
      "exported",
      "foreign_entered",
      "customs_cleared",
    ];

    await syncTrackingModuleStatusForOrder(
      "org-1",
      "order-1",
      "customs_cleared",
      "user-1",
      "2026-09-06T04:00:00.000Z",
    );

    expect(workflowFields).toHaveBeenCalledWith("org-1", "order-1", "tracking");
    const update = harness.batches[0].find((statement) =>
      statement.query.includes("UPDATE order_module_instances"),
    );
    expect(update?.bindings.slice(0, 4)).toEqual([
      "completed",
      "customs_cleared",
      "目的地清关",
      82,
    ]);
    expect(syncOrderWorkflowSnapshot).toHaveBeenCalledWith("org-1", "order-1");
  });

  it("keeps tracking open when a configured main in-transit node is missing", async () => {
    harness.state.progress = 82;
    harness.state.milestones = ["border_arrived", "exported", "customs_cleared"];

    await syncTrackingModuleStatusForOrder(
      "org-1",
      "order-1",
      "customs_cleared",
      "user-1",
      "2026-09-06T04:00:00.000Z",
    );

    const update = harness.batches[0].find((statement) =>
      statement.query.includes("UPDATE order_module_instances"),
    );
    expect(update?.bindings[0]).toBe("in_progress");
  });

  it("does not reopen a legacy tracking module after the overseas warehouse has already taken over", async () => {
    harness.state.progress = 100;
    harness.state.milestones = ["customs_cleared", "station_arrived"];

    await syncTrackingModuleStatusForOrder(
      "org-1",
      "order-1",
      "station_arrived",
      "warehouse-user-1",
      "2026-09-06T05:00:00.000Z",
    );

    const update = harness.batches[0].find((statement) =>
      statement.query.includes("UPDATE order_module_instances"),
    );
    expect(update?.bindings.slice(0, 4)).toEqual([
      "completed",
      "arrived",
      "目的仓到达",
      100,
    ]);
  });
});
