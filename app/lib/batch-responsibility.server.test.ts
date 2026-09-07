import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
import {
  batchInitialResponsibilityAssignmentGuard,
  loadBatchInitialResponsibilityRestrictions,
  loadBatchesInitialResponsibilityRestrictions,
} from "./batch-responsibility.server";

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: "batch-a",
    order_id: "order-228",
    order_number: "SO2026090400228",
    workflow_instance_id: "workflow-228",
    module_state_id: "module-state-228",
    module_code: "configured-operation-module",
    module_name: "配置中的操作模块",
    step_sort_order: 80,
    module_sort_order: 10,
    module_required: 1,
    module_status: "pending",
    module_position_code: "OPERATION",
    module_assignee_user_id: "operator-old",
    task_state_id: "task-state-228",
    task_key: "configured-task",
    task_name: "配置中的任务",
    task_sort_order: 10,
    task_required: 1,
    task_status: "pending",
    task_position_code: "OPERATION",
    task_assignee_user_id: "operator-old",
    assignee_user_id: "operator-old",
    assignee_name: "原操作员",
    ...overrides,
  };
}

describe("batch initial responsibility server policy", () => {
  it("loads former owners from configured frozen responsibility positions", async () => {
    const query = { sql: "", bindings: [] as unknown[] };
    const db = {
      prepare(sql: string) {
        query.sql = sql;
        return {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return {
              async all<T>() {
                return {
                  results: [
                    snapshotRow(),
                    snapshotRow({
                      order_id: "order-229",
                      order_number: "SO2026090400229",
                      workflow_instance_id: "workflow-229",
                      module_state_id: "module-state-229",
                      module_code: "configured-document-module",
                      module_name: "配置中的单证模块",
                      module_position_code: "DOC",
                      module_assignee_user_id: "document-old",
                      task_state_id: "task-state-229",
                      task_position_code: "DOC",
                      task_assignee_user_id: "document-old",
                      assignee_user_id: "document-old",
                      assignee_name: "原单证员",
                    }),
                  ] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const restrictions = await loadBatchInitialResponsibilityRestrictions(
      db,
      "org-a",
      "batch-a",
    );

    expect(restrictions.operation[0]).toMatchObject({
      userId: "operator-old",
      orderNumbers: ["SO2026090400228"],
      moduleCodes: ["configured-operation-module"],
    });
    expect(restrictions.document[0]).toMatchObject({
      userId: "document-old",
      orderNumbers: ["SO2026090400229"],
      moduleCodes: ["configured-document-module"],
    });
    expect(restrictions.configurationErrors).toContain(
      "SO2026090400228 冻结工作流中没有未完成的单证职责（DOC）",
    );
    expect(restrictions.configurationErrors).toContain(
      "SO2026090400229 冻结工作流中没有未完成的操作职责（OPERATION）",
    );
    expect(query.bindings).toEqual(["org-a", "batch-a"]);
    expect(query.sql).toContain("bo.status!='removed'");
    expect(query.sql).toContain("LEFT JOIN workflow_instances wi");
    expect(query.sql).toContain("wi.id=o.workflow_instance_id");
    expect(query.sql).toContain("workflow_instance_module_states ms");
    expect(query.sql).toContain("workflow_instance_task_states ts");
    expect(query.sql).toContain(
      "COALESCE(ts.responsibility_position_code,ms.responsibility_position_code)",
    );
    expect(query.sql).not.toContain("'tracking'");
    expect(query.sql).not.toContain("'documents'");
  });

  it("allows a mounted-order owner through the optimistic approval guard", () => {
    const guard = batchInitialResponsibilityAssignmentGuard({
      operationAssigneeUserId: "operator-old",
      documentAssigneeUserId: "document-old",
    });

    expect(guard.values).toEqual([]);
    expect(guard.sql).toBe("1=1");
  });

  it("reports snapshot configuration errors and loads a PZ page in one query", async () => {
    const query = { bindings: [] as unknown[] };
    const db = {
      prepare() {
        return {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return {
              async all<T>() {
                return { results: [
                  snapshotRow({
                    order_id: "order-a",
                    order_number: "SO-A",
                    module_assignee_user_id: "operator-a",
                    task_assignee_user_id: "operator-a",
                    assignee_user_id: "operator-a",
                    assignee_name: "原操作 A",
                  }),
                  snapshotRow({
                    batch_id: "batch-b",
                    order_id: "order-b",
                    order_number: "SO-B",
                    workflow_instance_id: null,
                    module_state_id: null,
                    module_code: null,
                    module_name: null,
                    module_status: null,
                    assignee_user_id: null,
                  }),
                ] as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const byBatch = await loadBatchesInitialResponsibilityRestrictions(
      db,
      "org-a",
      ["batch-a", "batch-b"],
    );

    expect(query.bindings).toEqual(["org-a", "batch-a", "batch-b"]);
    expect(byBatch["batch-a"].operation[0].userId).toBe("operator-a");
    expect(byBatch["batch-a"].configurationErrors).toContain(
      "SO-A 冻结工作流中没有未完成的单证职责（DOC）",
    );
    expect(byBatch["batch-b"].configurationErrors).toContain("SO-B 尚未锁定工作流实例");
  });
});
