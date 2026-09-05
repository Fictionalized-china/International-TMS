import { describe, expect, it } from "vitest";
import {
  loadWarehousePhysicalWorkflowAccess,
  warehousePhysicalWorkflowAccessSql,
  warehousePhysicalWorkflowVisibilitySql,
  type WarehousePhysicalWorkflowActor,
} from "./warehouse-workflow-access.server";

type TaskOwner = {
  assignee_user_id: string | null;
  responsibility_position_code: string | null;
};

type DatabaseOptions = {
  orderExists?: boolean;
  workflowInstanceId?: string | null;
  matchedInstanceId?: string | null;
  matchedInstanceStatus?: string | null;
  currentStepKey?: string | null;
  orderStatus?: string;
  modulePresent?: boolean;
  moduleStepKey?: string;
  moduleStatus?: string;
  moduleAssigneeUserId?: string | null;
  moduleResponsibility?: string | null;
  tasks?: TaskOwner[];
};

const actor: WarehousePhysicalWorkflowActor = {
  userId: "warehouse-user",
  positionCode: "WAREHOUSE",
};

const steps = {
  assignment: { step_name: "任务分配", sort_order: 10 },
  warehouse_receiving: { step_name: "国内仓入库", sort_order: 20 },
  customs: { step_name: "报关放行", sort_order: 30 },
};

function database(options: DatabaseOptions = {}) {
  const workflowInstanceId = options.workflowInstanceId === undefined
    ? "instance-1"
    : options.workflowInstanceId;
  const matchedInstanceId = options.matchedInstanceId === undefined
    ? workflowInstanceId
    : options.matchedInstanceId;
  const currentStepKey = options.currentStepKey === undefined
    ? "warehouse_receiving"
    : options.currentStepKey;
  const sql: string[] = [];
  const bindings: unknown[][] = [];
  const DB = {
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind(...values: unknown[]) {
          bindings.push(values);
          return statement;
        },
        async first() {
          if (query.includes("FROM transport_orders o")) {
            if (options.orderExists === false) return null;
            return {
              workflow_instance_id: workflowInstanceId,
              matched_instance_id: matchedInstanceId,
              matched_instance_status: options.matchedInstanceStatus ?? "active",
              current_step_key: currentStepKey,
              order_status: options.orderStatus ?? "in_execution",
            };
          }
          if (query.includes("SELECT step_name,sort_order")) {
            return currentStepKey
              ? steps[currentStepKey as keyof typeof steps] ?? null
              : null;
          }
          return null;
        },
        async all() {
          if (query.includes("JOIN workflow_instance_module_states ms")) {
            if (options.modulePresent === false) return { results: [] };
            const stepKey = options.moduleStepKey ?? "warehouse_receiving";
            const step = steps[stepKey as keyof typeof steps];
            return {
              results: [{
                id: "module-state-1",
                step_key: stepKey,
                step_name: step?.step_name ?? stepKey,
                sort_order: step?.sort_order ?? 20,
                module_status: options.moduleStatus ?? "pending",
                responsibility_position_code: options.moduleResponsibility === undefined
                  ? "WAREHOUSE"
                  : options.moduleResponsibility,
                module_assignee_user_id: options.moduleAssigneeUserId ?? null,
              }],
            };
          }
          if (query.includes("FROM workflow_instance_task_states")) {
            return { results: options.tasks ?? [] };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { DB, sql, bindings };
}

describe("warehouse physical workflow access", () => {
  it("allows only an actual SQL NULL binding as a legacy fallback", async () => {
    const fixture = database({ workflowInstanceId: null, matchedInstanceId: null, currentStepKey: null });

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "legacy-order",
      "warehouse",
      actor,
    )).resolves.toMatchObject({
      available: true,
      configured: false,
      legacyFallback: true,
      reason: null,
    });
    expect(fixture.sql).toHaveLength(1);
  });

  it.each([
    ["empty binding", { workflowInstanceId: "", matchedInstanceId: null }],
    ["cross-order or cross-organization binding", { matchedInstanceId: null }],
  ])("fails closed for an invalid %s", async (_label, options) => {
    const fixture = database(options);

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    )).resolves.toMatchObject({
      available: false,
      configured: true,
      legacyFallback: false,
      reason: "订单绑定的冻结工作流实例无效，请联系管理员修复后再办理",
    });
    expect(fixture.sql).toHaveLength(1);
    expect(fixture.sql[0]).toContain("wi.order_id=o.id");
  });

  it.each(["completed", "cancelled"])(
    "fails closed for a %s frozen workflow instance",
    async (matchedInstanceStatus) => {
      const fixture = database({ matchedInstanceStatus });

      await expect(loadWarehousePhysicalWorkflowAccess(
        fixture.DB,
        "org-1",
        "order-1",
        "warehouse",
        actor,
      )).resolves.toMatchObject({
        available: false,
        configured: true,
        legacyFallback: false,
        reason: "订单绑定的冻结工作流实例无效，请联系管理员修复后再办理",
      });
      expect(fixture.sql).toHaveLength(1);
    },
  );

  it("allows the responsible position only at the exact unfinished current module", async () => {
    const fixture = database();

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    )).resolves.toMatchObject({
      available: true,
      targetStepKey: "warehouse_receiving",
      legacyFallback: false,
    });
  });

  it("rejects a warehouse module before its node is current", async () => {
    const fixture = database({ currentStepKey: "assignment" });
    const access = await loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    );

    expect(access.available).toBe(false);
    expect(access.reason).toBe("当前处于“任务分配”，进入“国内仓入库”后自动开放");
  });

  it("rejects a warehouse module after its node has passed", async () => {
    const fixture = database({ currentStepKey: "customs" });
    const access = await loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    );

    expect(access.available).toBe(false);
    expect(access.reason).toBe("“国内仓入库”办理节点已结束，当前仅可查看历史记录");
  });

  it("rejects a completed current module", async () => {
    const fixture = database({ moduleStatus: "completed" });

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    )).resolves.toMatchObject({
      available: false,
      reason: "“国内仓入库”已完成，当前仅可查看历史记录",
    });
  });

  it("rejects a frozen task assigned to a different physical position", async () => {
    const fixture = database({
      tasks: [{ assignee_user_id: "other-user", responsibility_position_code: "OTHER_POSITION" }],
    });

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    )).resolves.toMatchObject({
      available: false,
      reason: "当前账号不是“国内仓入库”冻结任务的负责人，仅可查看",
    });
  });

  it("keeps a matching physical position available even when another person was assigned", async () => {
    const fixture = database({
      moduleResponsibility: "WAREHOUSE",
      tasks: [{ assignee_user_id: "other-user", responsibility_position_code: "WAREHOUSE" }],
    });

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    )).resolves.toMatchObject({ available: true });
  });

  it.each(["completed", "cancelled"])("rejects a %s order even with physical records", async (orderStatus) => {
    const fixture = database({ orderStatus });

    await expect(loadWarehousePhysicalWorkflowAccess(
      fixture.DB,
      "org-1",
      "order-1",
      "warehouse",
      actor,
    )).resolves.toMatchObject({ available: false });
    expect(fixture.sql).toHaveLength(1);
  });

  it("builds active queue SQL from the same exact-current owner and terminal rules", () => {
    const gate = warehousePhysicalWorkflowAccessSql("o", "overseas_warehouse", actor);

    expect(gate.values).toEqual([
      "overseas_warehouse",
      actor.positionCode,
      actor.positionCode,
    ]);
    expect(gate.sql).toContain("o.status NOT IN ('completed','cancelled')");
    expect(gate.sql).toContain("gate_instance.status='active'");
    expect(gate.sql).toContain("gate_instance.order_id=o.id");
    expect(gate.sql).toContain("gate_current_step.step_key=gate_instance.current_step_key");
    expect(gate.sql).toContain("gate_module.status!='completed'");
    expect(gate.sql).toContain("COALESCE(");
    expect(gate.sql).toContain("gate_position_task.responsibility_position_code");
    expect(gate.sql).not.toContain("assignee_user_id=?");
    expect(gate.sql).not.toContain("gate_current_step.sort_order>=gate_target_step.sort_order");
  });

  it("keeps a separate reached-node predicate for readonly history", () => {
    const visibility = warehousePhysicalWorkflowVisibilitySql("o", "overseas_warehouse");

    expect(visibility.values).toEqual(["overseas_warehouse"]);
    expect(visibility.sql).toContain("gate_instance.order_id=o.id");
    expect(visibility.sql).toContain("gate_current_step.sort_order>=gate_target_step.sort_order");
  });
});
