import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    rejectedModuleCode: null as string | null,
    batchCalls: [] as unknown[][],
  };
  const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) {
          statement.bindings = bindings;
          return statement;
        },
        async all<T>() {
          return { results: state.rows as T[] };
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: unknown[]) {
      state.batchCalls.push(statements);
      return [];
    },
  };
  return {
    state,
    prepared,
    DB,
    requireActiveOrganizationAssignee: vi.fn(async () => undefined),
    syncOrderWorkflowSnapshot: vi.fn(async () => undefined),
    resolveOrderModuleAssignmentTarget: vi.fn(async (input: { moduleCode: string }) => {
      if (input.moduleCode === state.rejectedModuleCode) {
        throw new Error("冻结责任或个人有效权限不符");
      }
      return null;
    }),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("./organization-assignee.server", () => ({
  requireActiveOrganizationAssignee: harness.requireActiveOrganizationAssignee,
}));
vi.mock("./order-assignment-manifest.server", () => ({
  resolveOrderModuleAssignmentTarget: harness.resolveOrderModuleAssignmentTarget,
  frozenWorkflowTaskAssignmentStatements: vi.fn(() => []),
}));
vi.mock("./order-modules.server", () => ({
  syncOrderWorkflowSnapshot: harness.syncOrderWorkflowSnapshot,
}));

import { assignOrderModulesBulk } from "./order-module-bulk-assignment.server";

function moduleRow(moduleCode: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `module-${moduleCode}`,
    module_code: moduleCode,
    module_name: moduleCode,
    enabled: 1,
    status: "in_progress",
    current_step_code: "working",
    current_step_name: "办理中",
    ...overrides,
  };
}

describe("atomic bulk order module assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.rows = [moduleRow("transport"), moduleRow("documents")];
    harness.state.rejectedModuleCode = null;
    harness.state.batchCalls = [];
    harness.prepared.length = 0;
  });

  it("全部验证通过后只执行一次 D1 batch", async () => {
    await expect(assignOrderModulesBulk({
      organizationId: "org-1",
      orderId: "order-1",
      actorUserId: "supervisor-1",
      assignments: [
        { moduleCode: "transport", assigneeUserId: "operator-1" },
        { moduleCode: "documents", assigneeUserId: "document-1" },
      ],
    })).resolves.toEqual({ assignedCount: 2 });

    expect(harness.resolveOrderModuleAssignmentTarget).toHaveBeenCalledTimes(2);
    expect(harness.requireActiveOrganizationAssignee).toHaveBeenCalledTimes(2);
    expect(harness.state.batchCalls).toHaveLength(1);
    expect(harness.state.batchCalls[0]).toHaveLength(8);
    expect(harness.syncOrderWorkflowSnapshot).toHaveBeenCalledTimes(1);
  });

  it("后续模块的冻结责任或权限校验失败时不写入前面模块", async () => {
    harness.state.rejectedModuleCode = "documents";

    await expect(assignOrderModulesBulk({
      organizationId: "org-1",
      orderId: "order-1",
      actorUserId: "supervisor-1",
      assignments: [
        { moduleCode: "transport", assigneeUserId: "operator-1" },
        { moduleCode: "documents", assigneeUserId: "document-1" },
      ],
    })).rejects.toThrow("冻结责任或个人有效权限不符");

    expect(harness.state.batchCalls).toHaveLength(0);
    expect(harness.syncOrderWorkflowSnapshot).not.toHaveBeenCalled();
  });

  it("所选模块未启用或已完成时在人员校验与写入前拒绝", async () => {
    harness.state.rows = [
      moduleRow("transport"),
      moduleRow("documents", { status: "completed" }),
    ];

    await expect(assignOrderModulesBulk({
      organizationId: "org-1",
      orderId: "order-1",
      actorUserId: "supervisor-1",
      assignments: [
        { moduleCode: "transport", assigneeUserId: "operator-1" },
        { moduleCode: "documents", assigneeUserId: "document-1" },
      ],
    })).rejects.toThrow("已完成或无需办理");

    expect(harness.state.batchCalls).toHaveLength(0);
  });
});
