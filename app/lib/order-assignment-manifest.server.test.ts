import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const state = {
    workflowInstanceId: "workflow-instance-1" as string | null,
    matchedWorkflowInstanceId: "workflow-instance-1" as string | null,
    matchedWorkflowInstanceStatus: "active" as string | null,
    rows: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ sql: string; values: unknown[] }>,
    batchSizes: [] as number[],
  };
  const DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          state.calls.push({ sql, values });
          return {
            async first() {
              if (sql.includes("workflow_instance_id") && sql.includes("transport_orders")) return {
                workflow_instance_id: state.workflowInstanceId,
                matched_instance_id: state.matchedWorkflowInstanceId,
                matched_instance_status: state.matchedWorkflowInstanceStatus,
              };
              return null;
            },
            async all() {
              if (sql.includes("FROM workflow_instance_module_states ms"))
                return { results: state.rows };
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      state.batchSizes.push(statements.length);
      return [];
    },
  } as unknown as D1Database;
  return { DB, state };
});

const assignees = vi.hoisted(() => ({
  valid: vi.fn(async () => true),
}));

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));
vi.mock("./organization-assignee.server", () => ({
  isActiveOrganizationAssigneeForWorkflowNodes: assignees.valid,
}));

import {
  applyOrderAssignmentManifest,
  frozenWorkflowTaskAssignmentStatements,
  loadOrderDispatchResponsibilityPolicy,
  loadOrderAssignmentManifest,
  prepareOrderAssignmentManifest,
  resolveOrderModuleAssignmentTarget,
  validateOrderAssignmentManifestSelections,
} from "./order-assignment-manifest.server";

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    module_state_id: "module-transport",
    module_code: "transport",
    module_name: "国内运输",
    step_key: "domestic_execution",
    step_sort_order: 40,
    module_sort_order: 10,
    module_required: 1,
    module_status: "pending",
    module_completion_mode: "all_tasks",
    module_position_code: "OPERATION",
    module_assignee_user_id: null,
    task_state_id: "task-transport",
    task_key: "arrange_transport",
    task_name: "安排国内运输",
    task_sort_order: 10,
    task_required: 1,
    task_status: "pending",
    task_position_code: "OPERATION",
    task_assignee_user_id: null,
    ...overrides,
  };
}

describe("frozen order assignment manifest server", () => {
  beforeEach(() => {
    database.state.workflowInstanceId = "workflow-instance-1";
    database.state.matchedWorkflowInstanceId = "workflow-instance-1";
    database.state.matchedWorkflowInstanceStatus = "active";
    database.state.rows = [
      dbRow(),
      dbRow({
        module_state_id: "module-assignment",
        module_code: "assignment",
        module_name: "任务分配",
        task_state_id: "task-assignment",
        task_key: "dispatch",
        task_name: "确认派单",
        module_position_code: "OPERATION_SUPERVISOR",
        task_position_code: "OPERATION_SUPERVISOR",
      }),
    ];
    database.state.calls = [];
    database.state.batchSizes = [];
    assignees.valid.mockClear();
  });

  it("loads enabled responsibility groups from the locked instance and omits the assignment orchestrator", async () => {
    const manifest = await loadOrderAssignmentManifest("organization-1", "order-1");

    expect(manifest.workflowInstanceId).toBe("workflow-instance-1");
    expect(manifest.groups.map((group) => group.positionCode)).toEqual(["OPERATION"]);
    expect(manifest.groups[0].modules.map((module) => module.moduleCode)).toEqual(["transport"]);
    expect(database.state.calls.some((call) =>
      call.values.includes("organization-1") && call.values.includes("order-1"),
    )).toBe(true);
  });

  it("derives the dispatch position from the first required frozen responsibility group", async () => {
    database.state.rows = [
      dbRow({
        module_state_id: "module-optional",
        module_code: "exceptions",
        module_name: "可选异常处理",
        module_required: 0,
      }),
      dbRow({
        module_state_id: "module-documents",
        module_code: "documents",
        module_name: "报关文件",
        step_sort_order: 50,
        module_position_code: "DOC",
        task_state_id: "task-documents",
        task_position_code: "DOC",
      }),
    ];

    await expect(loadOrderDispatchResponsibilityPolicy(
      "organization-1",
      "order-1",
    )).resolves.toEqual({
      source: "workflow_instance",
      workflowInstanceId: "workflow-instance-1",
      groupKey: "position:DOC",
      positionCode: "DOC",
    });
  });

  it("uses the explicit OPERATION legacy fallback only when the order has no snapshot", async () => {
    database.state.workflowInstanceId = null;
    database.state.matchedWorkflowInstanceId = null;

    await expect(loadOrderDispatchResponsibilityPolicy(
      "organization-1",
      "legacy-order",
    )).resolves.toEqual({
      source: "legacy",
      workflowInstanceId: null,
      groupKey: null,
      positionCode: "OPERATION",
    });
  });

  it("fails closed when the pointer does not match the same organization and order", async () => {
    database.state.workflowInstanceId = "foreign-instance";
    database.state.matchedWorkflowInstanceId = null;

    const manifest = await loadOrderAssignmentManifest("organization-1", "order-1");

    expect(manifest.workflowInstanceId).toBe("foreign-instance");
    expect(manifest.groups).toEqual([]);
    expect(manifest.configurationErrors.join("\n")).toContain("工作流实例绑定异常");
    const bindingQuery = database.state.calls.find((call) =>
      call.sql.includes("FROM transport_orders o"),
    )?.sql;
    expect(bindingQuery).toContain("wi.organization_id=o.organization_id");
    expect(bindingQuery).toContain("wi.order_id=o.id");
  });

  it("fails closed instead of treating a non-null blank workflow pointer as legacy", async () => {
    database.state.workflowInstanceId = "";
    database.state.matchedWorkflowInstanceId = null;
    database.state.matchedWorkflowInstanceStatus = null;

    const manifest = await loadOrderAssignmentManifest("organization-1", "order-1");

    expect(manifest.workflowInstanceId).toBe("");
    expect(manifest.groups).toEqual([]);
    expect(manifest.configurationErrors.join("\n")).toContain("工作流实例绑定异常");
  });

  it.each(["completed", "cancelled"])(
    "fails closed for a %s frozen workflow instance",
    async (status) => {
      database.state.matchedWorkflowInstanceStatus = status;

      const manifest = await loadOrderAssignmentManifest("organization-1", "order-1");

      expect(manifest.workflowInstanceId).toBe("workflow-instance-1");
      expect(manifest.groups).toEqual([]);
      expect(manifest.configurationErrors.join("\n")).toContain("工作流实例绑定异常");
      expect(database.state.calls[0].sql).toContain("wi.status matched_instance_status");
    },
  );

  it("rejects a frozen workflow that has no unfinished required human responsibility", async () => {
    database.state.rows = [dbRow({ module_required: 0 })];

    await expect(loadOrderDispatchResponsibilityPolicy(
      "organization-1",
      "order-1",
    )).rejects.toThrow("未配置后续必办人工责任岗位");
  });

  it("requires a concrete person only for required frozen groups", async () => {
    database.state.rows = [
      dbRow(),
      dbRow({
        module_state_id: "module-exceptions",
        module_code: "exceptions",
        module_name: "异常处理",
        module_required: 0,
        task_state_id: "task-exceptions",
        task_key: "record_exception",
        task_name: "记录异常",
        task_required: 1,
      }),
    ];

    await expect(validateOrderAssignmentManifestSelections({
      organizationId: "organization-1",
      orderId: "order-1",
      selections: [],
    })).rejects.toThrow("选择OPERATION的具体个人账户");

    await expect(validateOrderAssignmentManifestSelections({
      organizationId: "organization-1",
      orderId: "order-1",
      selections: [{ groupKey: "position:OPERATION", assigneeUserId: "operator-1" }],
    })).resolves.toMatchObject({
      resolvedGroups: [{ assigneeUserId: "operator-1", selectedNow: true }],
    });
    expect(assignees.valid).toHaveBeenCalledWith({
      organizationId: "organization-1",
      userId: "operator-1",
      responsibilityPositionCode: "OPERATION",
      nodes: [
        { stepKey: "domestic_execution", moduleCode: "exceptions" },
        { stepKey: "domestic_execution", moduleCode: "transport" },
      ],
      permissionRequirements: [["order.view"]],
    });
  });

  it("does not require or accept a personal assignee for a physical warehouse queue", async () => {
    database.state.rows = [dbRow({
      module_state_id: "module-warehouse",
      module_code: "warehouse",
      module_name: "国内仓入库",
      module_position_code: "WAREHOUSE",
      task_state_id: "task-warehouse",
      task_position_code: "WAREHOUSE",
    })];

    await expect(validateOrderAssignmentManifestSelections({
      organizationId: "organization-1",
      orderId: "order-1",
      selections: [],
    })).resolves.toMatchObject({ resolvedGroups: [] });
    expect(assignees.valid).not.toHaveBeenCalled();

    await expect(validateOrderAssignmentManifestSelections({
      organizationId: "organization-1",
      orderId: "order-1",
      selections: [{
        groupKey: "position:WAREHOUSE",
        assigneeUserId: "warehouse-user",
      }],
    })).rejects.toThrow("岗位队列办理");

    await expect(resolveOrderModuleAssignmentTarget({
      organizationId: "organization-1",
      orderId: "order-1",
      moduleCode: "warehouse",
      assigneeUserId: "warehouse-user",
    })).rejects.toThrow("不能改派给个人账户");
  });

  it("rejects a person outside the responsibility position configured in the snapshot", async () => {
    database.state.rows = [dbRow()];
    assignees.valid.mockResolvedValueOnce(false);

    await expect(validateOrderAssignmentManifestSelections({
      organizationId: "organization-1",
      orderId: "order-1",
      selections: [{ groupKey: "position:OPERATION", assigneeUserId: "document-user" }],
    })).rejects.toThrow("OPERATION负责人不具备该责任所需的节点资格");
  });

  it("requires an explicit position when one module contains task-level responsibility overrides", async () => {
    database.state.rows = [
      dbRow(),
      dbRow({
        task_state_id: "task-documents",
        task_key: "documents",
        task_name: "准备随车文件",
        task_sort_order: 20,
        task_position_code: "DOC",
      }),
    ];

    await expect(resolveOrderModuleAssignmentTarget({
      organizationId: "organization-1",
      orderId: "order-1",
      moduleCode: "transport",
      assigneeUserId: "operator-1",
    })).rejects.toThrow("包含多个责任岗位");

    await expect(resolveOrderModuleAssignmentTarget({
      organizationId: "organization-1",
      orderId: "order-1",
      moduleCode: "transport",
      assigneeUserId: "document-user",
      responsibilityPositionCode: "DOC",
    })).resolves.toMatchObject({
      positionCode: "DOC",
      primaryOwner: false,
      taskStateIds: ["task-documents"],
    });
  });

  it("prepares a task-state projection guarded by the same order and locked instance", async () => {
    database.state.rows = [dbRow()];
    const target = await resolveOrderModuleAssignmentTarget({
      organizationId: "organization-1",
      orderId: "order-1",
      moduleCode: "transport",
      assigneeUserId: "operator-1",
    });
    expect(target).not.toBeNull();
    database.state.calls = [];

    const statements = frozenWorkflowTaskAssignmentStatements({
      organizationId: "organization-1",
      orderId: "order-1",
      assigneeUserId: "operator-1",
      now: "2026-09-06T00:00:00.000Z",
      target: target!,
    });

    expect(statements).toHaveLength(1);
    const update = database.state.calls.find((call) =>
      call.sql.includes("UPDATE workflow_instance_task_states"),
    );
    expect(update?.sql).toContain("wi.organization_id=? AND wi.order_id=?");
    expect(update?.values).toEqual([
      "operator-1",
      "2026-09-06T00:00:00.000Z",
      "task-transport",
      "workflow-instance-1",
      "organization-1",
      "order-1",
    ]);
  });

  it("does not persist assignment statements before the workflow transition batch", async () => {
    database.state.rows = [dbRow()];

    const result = await prepareOrderAssignmentManifest({
      organizationId: "organization-1",
      orderId: "order-1",
      actorUserId: "supervisor-1",
      selections: [{
        groupKey: "position:OPERATION",
        assigneeUserId: "operator-1",
      }],
    });

    expect(database.state.batchSizes).toEqual([]);
    expect(result.statements.length).toBeGreaterThan(0);
    expect(result.prospectiveSatisfiedGateFieldKeys).toEqual([
      "primary_operator",
      "module_assignees",
      "assignment_scope",
    ]);
  });

  it("projects a validated manifest to module owners, order tasks and frozen task owners", async () => {
    database.state.rows = [
      dbRow(),
      dbRow({
        task_state_id: "task-documents",
        task_key: "documents",
        task_name: "准备随车文件",
        task_sort_order: 20,
        task_position_code: "DOC",
      }),
    ];

    const result = await applyOrderAssignmentManifest({
      organizationId: "organization-1",
      orderId: "order-1",
      actorUserId: "supervisor-1",
      selections: [
        { groupKey: "position:OPERATION", assigneeUserId: "operator-1" },
        { groupKey: "position:DOC", assigneeUserId: "document-user" },
      ],
      now: "2026-09-06T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      assignedGroupCount: 2,
      assignedModuleCodes: ["transport"],
      primaryAssigneeUserId: "operator-1",
    });
    expect(database.state.batchSizes).toEqual([8]);
    expect(database.state.calls.filter((call) =>
      call.sql.includes("UPDATE workflow_instance_task_states"),
    )).toHaveLength(2);
    expect(database.state.calls.filter((call) =>
      call.sql.includes("UPDATE order_module_instances SET assignee_user_id"),
    )).toHaveLength(1);
    expect(database.state.calls.filter((call) =>
      call.sql.includes("INSERT INTO order_tasks"),
    )).toHaveLength(2);
  });

  it("returns the same first required frozen group as the workflow dispatch owner", async () => {
    database.state.rows = [
      dbRow({
        module_state_id: "module-optional",
        module_code: "exceptions",
        module_name: "可选异常处理",
        module_required: 0,
      }),
      dbRow({
        module_state_id: "module-documents",
        module_code: "documents",
        module_name: "报关文件",
        step_sort_order: 50,
        module_position_code: "DOC",
        task_state_id: "task-documents",
        task_position_code: "DOC",
      }),
    ];

    await expect(applyOrderAssignmentManifest({
      organizationId: "organization-1",
      orderId: "order-1",
      actorUserId: "supervisor-1",
      selections: [
        { groupKey: "position:DOC", assigneeUserId: "document-user" },
      ],
      now: "2026-09-06T02:00:00.000Z",
    })).resolves.toMatchObject({
      assignedGroupCount: 1,
      primaryAssigneeUserId: "document-user",
    });
  });
});
