import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "user-a",
    permissions: [
      "order.view",
      "order.scope.assigned",
      "order.module.transport.manage",
      "order.module.assignment.manage",
    ],
    positionCode: "OPERATION",
    roleCodes: ["pos_operation"],
  };
  const order = {
    status: "in_execution",
    business_type: "ftl",
    shipper_name: "Shipper",
    origin_country: "China",
    origin_state: null,
    origin_city: "Shenzhen",
    origin_address: "Origin",
    consignee_name: "Consignee",
    destination_country: "Kazakhstan",
    destination_state: null,
    destination_city: "Almaty",
    destination_address: "Destination",
    exit_port: null,
    transit_locations: null,
    customs_location: null,
    route_notes: null,
    overseas_warehouse_id: null,
    requires_transloading: 0,
    requires_transit_customs: 0,
    current_assignee_user_id: "user-a",
    salesperson_user_id: null,
    workflow_instance_id: null as string | null,
  };
  const state = {
    task: null as Record<string, unknown> | null,
    actorPositions: [{ code: "OPERATION" }] as Record<string, unknown>[],
    updateChanges: 1,
    updateRuns: 0,
    batchRuns: 0,
    modules: [] as Array<Record<string, unknown>>,
    workflowFields: [] as Array<Record<string, unknown>>,
    documentReviews: [] as Array<{ document_category: string; review_status: string | null }>,
    moduleAssigneeUserId: "user-a" as string | null,
    moduleTaskAssigneeUserIds: ["user-a"] as string[],
    trackingActionEditable: true,
    trackingActionReason: null as string | null,
  };
  const sql: string[] = [];
  const DB = {
    async batch() {
      state.batchRuns += 1;
      return [];
    },
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (query.includes("FROM transport_orders WHERE id=? AND organization_id=?")) {
            return order;
          }
          if (query.includes("FROM order_tasks t")) {
            return state.task;
          }
          return null;
        },
        async all() {
          if (query.includes("FROM positions p")) {
            return { results: state.actorPositions };
          }
          if (query.includes("FROM order_document_metadata")) {
            return { results: state.documentReviews };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes("UPDATE order_tasks")) {
            state.updateRuns += 1;
            return { meta: { changes: state.updateChanges } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return {
    current,
    order,
    state,
    sql,
    DB,
    requireSessionUser: vi.fn(async () => current),
    requireOrderAccess: vi.fn(async () => undefined),
    ensureOrderModules: vi.fn(async () => undefined),
    loadOrderModuleActionScope: vi.fn(async (
      _organizationId: string,
      _orderId: string,
      moduleCode: string,
    ) => ({
      moduleCode,
      enabled: true,
      assigneeUserId: state.moduleAssigneeUserId,
      taskAssigneeUserIds: state.moduleTaskAssigneeUserIds,
      responsibilityPositionCodes: ["OPERATION"],
    })),
    loadOrderTrackingActionAccess: vi.fn(async (input: { canOperate: boolean }) => {
      const editable = state.trackingActionEditable && input.canOperate;
      const reason = !input.canOperate
        ? "当前账号不是本单已分配的运踪负责人，或缺少运踪办理权限"
        : state.trackingActionReason;
      const action = (fieldKey: "tracking_milestone" | "actual_exit_at") => ({
        fieldKey,
        source: "frozen",
        status: editable ? "editable" : "read_only",
        configured: true,
        configurationValid: true,
        visible: true,
        editable,
        required: true,
        stageRelation: editable ? "current" : "before",
        targetStepKey: "module:tracking",
        targetStepName: "实际出境及运踪",
        reason,
      });
      return {
        tracking_milestone: action("tracking_milestone"),
        actual_exit_at: action("actual_exit_at"),
      };
    }),
    writeAudit: vi.fn(async () => undefined),
    assignOrderModule: vi.fn(async () => undefined),
    assignOrderModulesBulk: vi.fn(async () => ({ assignedCount: 0 })),
    runOrderWorkflowAction: vi.fn(async () => ({ success: "workflow advanced" })),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({
  requireSessionUser: harness.requireSessionUser,
}));
vi.mock("../lib/order-access.server", () => ({
  requireOrderAccess: harness.requireOrderAccess,
}));
vi.mock("../lib/audit.server", () => ({
  writeAudit: harness.writeAudit,
}));
vi.mock("../lib/order-modules.server", () => ({
  advanceOrderModule: vi.fn(),
  assignOrderModule: harness.assignOrderModule,
  ensureOrderModules: harness.ensureOrderModules,
  listOrderModules: vi.fn(async () => harness.state.modules),
  loadOrderModuleActionScope: harness.loadOrderModuleActionScope,
  syncCostsModuleStatus: vi.fn(),
  syncOrderWorkflowSnapshot: vi.fn(),
}));
vi.mock("../lib/order-module-bulk-assignment.server", () => ({
  assignOrderModulesBulk: harness.assignOrderModulesBulk,
}));
vi.mock("../lib/order-workflow-action.server", () => ({
  runOrderWorkflowAction: harness.runOrderWorkflowAction,
}));
vi.mock("../lib/organization-assignee.server", () => ({
  isActiveOrganizationAssignee: vi.fn(async () => true),
  isActiveOrganizationAssigneeForPositions: vi.fn(async () => true),
  listActiveOrganizationAssignees: vi.fn(async () => []),
}));
vi.mock("../lib/workflow-fields.server", () => ({
  loadOrderModuleWorkflowFields: vi.fn(async () => harness.state.workflowFields),
  missingRequiredModuleFields: vi.fn(async () => []),
  saveOrderCustomWorkflowFieldValue: vi.fn(),
}));
vi.mock("../lib/workflow-instance-stage-gate.server", () => ({
  loadLockedWorkflowStageContext: vi.fn(async (
    _db: unknown,
    _organizationId: string,
    _orderId: string,
    moduleCode: string,
  ) => ({
    locked: true,
    currentStepKey: `module:${moduleCode}`,
    steps: [{
      stepKey: `module:${moduleCode}`,
      stepName: "Current module",
      sortOrder: 10,
    }],
    modulePlacements: [{
      moduleCode,
      stepKey: `module:${moduleCode}`,
    }],
    fields: [],
  })),
}));
vi.mock("../lib/order-tracking-action-policy.server", () => ({
  loadOrderTrackingActionAccess: harness.loadOrderTrackingActionAccess,
}));

import { action } from "./admin.order-module";

function post(intent: string, values: Record<string, string> = {}) {
  return new Request("http://local.test/admin/orders/order-1/modules/transport", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent, ...values }),
  });
}

function invoke(request: Request, moduleCode = "transport") {
  return action({
    request,
    params: { orderId: "order-1", moduleCode },
    context: undefined,
  } as never);
}

describe("order module action mutation gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.task = {
      id: "task-1",
      module_code: "transport",
      status: "pending",
      task_assignee_user_id: "user-a",
      module_assignee_user_id: "user-a",
      responsibility_position_code: "OPERATION",
      workflow_instance_id: "instance-1",
      frozen_current_module: 1,
      current_step_code: "module:transport",
    };
    harness.state.actorPositions = [{ code: "OPERATION" }];
    harness.state.updateChanges = 1;
    harness.state.updateRuns = 0;
    harness.state.batchRuns = 0;
    harness.state.modules = [];
    harness.order.status = "in_execution";
    harness.order.workflow_instance_id = null;
    harness.sql.length = 0;
    harness.current.permissions = [
      "order.view",
      "order.scope.assigned",
      "order.module.transport.manage",
      "order.module.assignment.manage",
    ];
    harness.current.positionCode = "OPERATION";
    harness.state.workflowFields = [];
    harness.state.documentReviews = [];
    harness.state.moduleAssigneeUserId = "user-a";
    harness.state.moduleTaskAssigneeUserIds = ["user-a"];
    harness.state.trackingActionEditable = true;
    harness.state.trackingActionReason = null;
  });

  it("rejects a forged document upload through a different module URL", async () => {
    await expect(invoke(post("document_upload", {
      documentCategory: "billing_statement",
    }))).resolves.toEqual({
      formError: "该文件属于其他业务模块，不能跨模块办理",
    });
    expect(harness.sql.some((query) =>
      query.includes("INSERT INTO order_document_metadata"),
    )).toBe(false);
  });

  it("rejects completion of a task belonging to another module", async () => {
    harness.state.task = { ...harness.state.task, module_code: "costs" };
    await expect(invoke(post("task_complete", { taskId: "task-1" })))
      .resolves.toEqual({ formError: "该待办不属于当前模块、已完成或不存在" });
    expect(harness.state.updateRuns).toBe(0);
  });

  it("rejects a task outside the current frozen workflow module", async () => {
    harness.state.task = { ...harness.state.task, frozen_current_module: 0 };
    await expect(invoke(post("task_complete", { taskId: "task-1" })))
      .resolves.toEqual({ formError: "该待办不属于当前冻结工作流节点" });
    expect(harness.state.updateRuns).toBe(0);
  });

  it("rejects a different task owner even when the actor has the same position", async () => {
    harness.state.task = { ...harness.state.task, task_assignee_user_id: "user-b" };
    await expect(invoke(post("task_complete", { taskId: "task-1" })))
      .resolves.toEqual({ formError: "当前账号不是该待办的指定负责人" });
    expect(harness.state.updateRuns).toBe(0);
  });

  it("completes only the current assigned pending task with an atomic update", async () => {
    await expect(invoke(post("task_complete", { taskId: "task-1" })))
      .resolves.toEqual({ success: "任务已完成" });
    expect(harness.state.updateRuns).toBe(1);
    expect(harness.writeAudit).toHaveBeenCalledTimes(1);
    const taskQuery = harness.sql.find((query) => query.includes("FROM order_tasks t"));
    expect(taskQuery).toContain("wi.current_step_key");
    expect(taskQuery).toContain("wi.organization_id=o.organization_id");
    expect(taskQuery).toContain("wi.order_id=o.id");
    expect(harness.sql.find((query) => query.includes("UPDATE order_tasks")))
      .toContain("status IN ('pending','in_progress')");
  });

  it("reports a concurrent task state change instead of claiming success", async () => {
    harness.state.updateChanges = 0;
    await expect(invoke(post("task_complete", { taskId: "task-1" })))
      .resolves.toEqual({ formError: "待办状态已变化，请刷新后重试" });
    expect(harness.writeAudit).not.toHaveBeenCalled();
  });

  it.each(["", "instance-active", "instance-wrong", "instance-completed"])(
    "rejects legacy confirm_dispatch for every non-NULL workflow binding (%j)",
    async (workflowInstanceId) => {
      harness.order.status = "confirmed";
      harness.order.workflow_instance_id = workflowInstanceId;

      await expect(invoke(post("confirm_dispatch", {
        assigneeUserId: "user-a",
      }), "assignment")).resolves.toEqual({
        formError: "该订单已绑定工作流实例，请使用工作流责任分配确认派单",
      });
      expect(harness.state.batchRuns).toBe(0);
      expect(harness.runOrderWorkflowAction).not.toHaveBeenCalled();
    },
  );

  it("将真正旧订单的确认派单更新与工作流迁移原子提交", async () => {
    harness.order.status = "confirmed";
    harness.state.modules = [{
      module_code: "transport",
      module_name: "国内运输",
      enabled: 1,
      status: "in_progress",
      assignee_user_id: "user-a",
    }];

    await expect(invoke(post("confirm_dispatch", {
      assigneeUserId: "user-a",
    }), "assignment")).resolves.toEqual({ success: "workflow advanced" });
    expect(harness.state.batchRuns).toBe(0);
    expect(harness.runOrderWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCode: "dispatch",
        atomicStatements: expect.arrayContaining([expect.anything(), expect.anything()]),
      }),
    );
  });

  it("将全量校验后的旧订单批量选择交给一次原子分配", async () => {
    harness.order.status = "confirmed";
    harness.state.modules = [
      { module_code: "transport", module_name: "国内运输", enabled: 1, status: "in_progress" },
      { module_code: "documents", module_name: "单证处理", enabled: 1, status: "not_started" },
    ];
    const request = new Request("http://local.test/admin/orders/order-1/modules/assignment", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["intent", "assign_bulk"],
        ["assigneeUserId", "user-a"],
        ["targetModuleCode", "transport"],
        ["targetModuleCode", "documents"],
      ]),
    });

    await expect(invoke(request, "assignment")).resolves.toEqual({
      success: "已批量分配 2 个模块，待确认派单后进度推进。",
    });
    expect(harness.assignOrderModulesBulk).toHaveBeenCalledTimes(1);
    expect(harness.assignOrderModule).not.toHaveBeenCalled();
  });

  it("任一所选模块无效时在写入前拒绝整个批量请求", async () => {
    harness.order.status = "confirmed";
    harness.state.modules = [
      { module_code: "transport", module_name: "国内运输", enabled: 1, status: "in_progress" },
    ];
    const request = new Request("http://local.test/admin/orders/order-1/modules/assignment", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["intent", "assign_bulk"],
        ["assigneeUserId", "user-a"],
        ["targetModuleCode", "transport"],
        ["targetModuleCode", "missing-module"],
      ]),
    });

    await expect(invoke(request, "assignment")).resolves.toEqual({
      formError: "选中的模块不存在、未启用或已完成：missing-module",
    });
    expect(harness.assignOrderModulesBulk).not.toHaveBeenCalled();
  });

  it("拒绝对已绑定工作流实例的订单调用旧 assign_bulk", async () => {
    harness.order.status = "confirmed";
    harness.order.workflow_instance_id = "instance-active";

    await expect(invoke(post("assign_bulk", {
      assigneeUserId: "user-a",
      targetModuleCode: "transport",
    }), "assignment")).resolves.toEqual({
      formError: "该订单已绑定工作流实例，请按冻结责任组分配",
    });
    expect(harness.assignOrderModulesBulk).not.toHaveBeenCalled();
  });

  it("uses the frozen workflow document policy to block customs release", async () => {
    harness.current.permissions = [
      "order.view",
      "order.scope.assigned",
      "order.module.customs.manage",
    ];
    harness.current.positionCode = "DOC";
    harness.state.workflowFields = [
      {
        fieldKey: "document_commercial_invoice",
        isActive: true,
        isRequired: true,
      },
      {
        fieldKey: "document_packing_list",
        isActive: true,
        isRequired: false,
      },
    ];
    harness.state.documentReviews = [
      { document_category: "commercial_invoice", review_status: "pending" },
    ];

    await expect(invoke(post("customs_save", {
      status: "released",
      declarationNumber: "CUS-001",
    }), "customs")).resolves.toEqual({
      formError: "确认报关放行前请先上传并审核：发票",
    });
    expect(harness.sql.some((query) =>
      query.includes("SELECT DISTINCT document_category,review_status"),
    )).toBe(true);
    expect(harness.sql.some((query) =>
      query.includes("INSERT INTO order_customs_records"),
    )).toBe(false);
  });

  it.each([
    ["border_arrived", "tracking_milestone"],
    ["exported", "actual_exit_at"],
  ] as const)(
    "rechecks the %s frozen action field before any tracking write",
    async (milestoneCode, fieldKey) => {
      harness.current.permissions = [
        "order.view",
        "order.scope.assigned",
        "order.module.tracking.manage",
      ];
      harness.state.trackingActionEditable = false;
      harness.state.trackingActionReason = "当前尚未进入实际出境及运踪";

      await expect(invoke(post("tracking_add", {
        milestoneCode,
        eventAt: "2026-09-06T12:00",
        location: "Horgos",
        visibleToCustomer: "1",
      }), "tracking")).resolves.toEqual({
        formError: "当前尚未进入实际出境及运踪",
      });

      expect(harness.loadOrderTrackingActionAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          orderId: "order-1",
          canOperate: true,
          legacyCompatibility: "deny",
        }),
      );
      const access = await harness.loadOrderTrackingActionAccess.mock.results.at(-1)?.value;
      expect(access[fieldKey].editable).toBe(false);
      expect(harness.state.batchRuns).toBe(0);
    },
  );

  it("uses the same frozen tracking gate for option mutations", async () => {
    harness.current.permissions = [
      "order.view",
      "order.scope.assigned",
      "order.module.tracking.manage",
    ];
    harness.state.trackingActionEditable = false;
    harness.state.trackingActionReason = "运踪节点已经结束，仅供查看";

    await expect(invoke(post("tracking_option_toggle", {
      optionCode: "transloaded",
      enabled: "1",
    }), "tracking")).resolves.toEqual({
      formError: "运踪节点已经结束，仅供查看",
    });
    expect(harness.sql.some((query) => query.includes("UPDATE transport_orders SET"))).toBe(false);
  });

  it("passes exact module assignment into the shared gate instead of trusting page visibility", async () => {
    harness.current.permissions = [
      "order.view",
      "order.scope.assigned",
      "order.module.tracking.manage",
    ];
    harness.state.moduleAssigneeUserId = "user-b";
    harness.state.moduleTaskAssigneeUserIds = ["user-b"];

    await expect(invoke(post("tracking_add", {
      milestoneCode: "border_arrived",
    }), "tracking")).resolves.toEqual({
      formError: "当前账号不是本单已分配的运踪负责人，或缺少运踪办理权限",
    });
    expect(harness.loadOrderTrackingActionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ canOperate: false }),
    );
    expect(harness.state.batchRuns).toBe(0);
  });
});
