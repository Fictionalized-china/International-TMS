import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    stageRows: [] as Array<{
      order_id: string;
      order_status: string;
      bound_instance_id: string | null;
      matched_instance_id: string | null;
      matched_instance_status: string | null;
      current_step_state_id: string | null;
      current_step_key: string | null;
      current_step_name: string | null;
      current_step_status: string | null;
      current_step_sort_order: number | null;
      target_module_state_id: string | null;
      target_module_status: string | null;
      target_step_key: string | null;
      target_step_name: string | null;
      target_step_sort_order: number | null;
      applies_to_current_or_future: number;
    }>,
    fieldRows: [] as Array<{
      order_id: string;
      step_key: string;
      field_key: string;
      is_active: number;
      is_required: number;
    }>,
  };
  const sql: string[] = [];
  const DB = {
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          return {
            results: query.includes("applies_to_current_or_future")
              ? state.stageRows
              : state.fieldRows,
          };
        },
      };
      return statement;
    },
  };
  return { state, sql, DB };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));

import { resolveLoadingBatchFieldPolicies } from "./loading-batch-field-policy";
import { loadLoadingBatchWorkflowOrders } from "./loading-batch-field-policy.server";

describe("loading batch frozen workflow binding", () => {
  function frozenStage(overrides: Partial<(typeof harness.state.stageRows)[number]> = {}) {
    return {
      order_id: "order-1",
      order_status: "in_execution",
      bound_instance_id: "instance-1",
      matched_instance_id: "instance-1",
      matched_instance_status: "active",
      current_step_state_id: "step-current",
      current_step_key: "custom_loading",
      current_step_name: "自定义装车",
      current_step_status: "active",
      current_step_sort_order: 60,
      target_module_state_id: "module-loading",
      target_module_status: "pending",
      target_step_key: "custom_loading",
      target_step_name: "自定义装车",
      target_step_sort_order: 60,
      applies_to_current_or_future: 1,
      ...overrides,
    };
  }

  beforeEach(() => {
    harness.sql.length = 0;
    harness.state.stageRows = [];
    harness.state.fieldRows = [];
  });

  it("rejects a non-null pointer that does not match the same organization and order", async () => {
    harness.state.stageRows = [frozenStage({
      bound_instance_id: "foreign-instance",
      matched_instance_id: null,
      matched_instance_status: null,
      current_step_state_id: null,
      target_module_state_id: null,
      applies_to_current_or_future: 0,
    })];

    const [order] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);
    expect(order).toMatchObject({
      loadingStageAvailable: false,
      loadingStageReason: "订单绑定的冻结工作流实例无效，请联系管理员修复后再办理装车与出库",
    });
    expect(harness.sql.join("\n")).toContain("wi.organization_id=o.organization_id");
    expect(harness.sql.join("\n")).toContain("wi.order_id=o.id");
  });

  it("keeps absent fields hidden for a valid frozen snapshot", async () => {
    harness.state.stageRows = [frozenStage()];

    const orders = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);
    const policy = resolveLoadingBatchFieldPolicies(orders);

    expect(policy.exit_port).toMatchObject({
      isActive: false,
      isRequired: false,
      mode: "hidden",
    });
    expect(harness.sql.join("\n")).toContain("JOIN workflow_instance_fields f");
    expect(harness.sql.join("\n")).not.toContain("workflow_step_fields");
  });

  it("uses fields only from the unique frozen loading target", async () => {
    harness.state.stageRows = [frozenStage()];
    harness.state.fieldRows = [{
      order_id: "order-1",
      step_key: "custom_loading",
      field_key: "exit_port",
      is_active: 1,
      is_required: 1,
    }];

    const [order] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    expect(order.loadingStageAvailable).toBe(true);
    expect(order.fields).toEqual([{
      fieldKey: "exit_port",
      isActive: true,
      isRequired: true,
    }]);
    expect(harness.sql.join("\n")).toContain("f.step_key");
  });

  it("fails closed for loading fields placed on another step or duplicated", async () => {
    harness.state.stageRows = [frozenStage()];
    harness.state.fieldRows = [{
      order_id: "order-1",
      step_key: "wrong_step",
      field_key: "exit_port",
      is_active: 1,
      is_required: 1,
    }];
    const [wrongStep] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    harness.state.fieldRows = [
      {
        order_id: "order-1",
        step_key: "custom_loading",
        field_key: "exit_port",
        is_active: 1,
        is_required: 1,
      },
      {
        order_id: "order-1",
        step_key: "custom_loading",
        field_key: "exit_port",
        is_active: 1,
        is_required: 0,
      },
    ];
    const [duplicate] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    expect(wrongStep).toMatchObject({
      loadingStageAvailable: false,
      fields: [],
    });
    expect(wrongStep.loadingStageReason).toContain("字段配置在非目标节点");
    expect(duplicate).toMatchObject({
      loadingStageAvailable: false,
      fields: [],
    });
    expect(duplicate.loadingStageReason).toContain("字段存在重复配置");
  });

  it("uses catalog defaults only for an explicitly unbound legacy order", async () => {
    harness.state.stageRows = [frozenStage({
      order_id: "legacy-order",
      bound_instance_id: null,
      matched_instance_id: null,
      matched_instance_status: null,
      current_step_state_id: null,
      current_step_key: null,
      current_step_name: null,
      current_step_status: null,
      current_step_sort_order: null,
      target_module_state_id: null,
      target_module_status: null,
      target_step_key: null,
      target_step_name: null,
      target_step_sort_order: null,
    })];

    const orders = await loadLoadingBatchWorkflowOrders("org-1", ["legacy-order"]);
    const policy = resolveLoadingBatchFieldPolicies(orders);

    expect(policy.exit_port).toMatchObject({
      isActive: true,
      isRequired: true,
      mode: "required",
    });
    expect(orders[0]).toMatchObject({
      loadingStageAvailable: true,
      loadingStageReason: null,
    });
    expect(harness.sql.join("\n")).not.toContain("workflow_step_fields");
  });

  it("keeps terminal legacy orders read-only instead of applying the fallback gate", async () => {
    harness.state.stageRows = [frozenStage({
      order_id: "legacy-completed",
      order_status: "completed",
      bound_instance_id: null,
      matched_instance_id: null,
      matched_instance_status: null,
      current_step_state_id: null,
      current_step_key: null,
      current_step_name: null,
      current_step_status: null,
      current_step_sort_order: null,
      target_module_state_id: null,
      target_module_status: null,
      target_step_key: null,
      target_step_name: null,
      target_step_sort_order: null,
    })];

    const [order] = await loadLoadingBatchWorkflowOrders("org-1", ["legacy-completed"]);

    expect(order).toMatchObject({
      loadingStageAvailable: false,
      loadingStageReason: "订单已完成，当前仅可查看装车与出库历史",
    });
  });

  it("derives the loading target and reason from a custom frozen step", async () => {
    harness.state.stageRows = [frozenStage({
      current_step_state_id: "step-precheck",
      current_step_key: "custom_precheck",
      current_step_name: "装车前复核",
      current_step_sort_order: 50,
      applies_to_current_or_future: 1,
    })];

    const [order] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    expect(order).toMatchObject({
      currentStepKey: "custom_precheck",
      appliesToCurrentOrFuture: true,
      loadingStageAvailable: false,
      loadingTargetStepKey: "custom_loading",
      loadingTargetStepName: "自定义装车",
      loadingStageReason: "当前处于“装车前复核”，进入“自定义装车”后开放装车与出库办理",
    });
    expect(harness.sql.join("\n")).toContain("workflow_instance_module_states");
    expect(harness.sql.join("\n")).toContain("workflow_instance_step_states");
    expect(harness.sql.join("\n")).not.toContain("target_step.step_key='port_loading'");
    expect(harness.sql.join("\n")).not.toContain("workflow_steps");
  });

  it("opens only at the exact custom loading step and closes after it", async () => {
    harness.state.stageRows = [frozenStage()];
    const [current] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);
    harness.state.stageRows = [frozenStage({
      current_step_state_id: "step-customs",
      current_step_key: "custom_customs",
      current_step_name: "自定义报关",
      current_step_sort_order: 70,
      applies_to_current_or_future: 0,
    })];
    const [past] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    expect(current.loadingStageAvailable).toBe(true);
    expect(current.currentStepKey).toBe("custom_loading");
    expect(current.loadingStageReason).toBeNull();
    expect(past).toMatchObject({
      currentStepKey: "custom_customs",
      appliesToCurrentOrFuture: false,
      loadingStageAvailable: false,
      loadingStageReason: "“自定义装车”办理节点已结束，当前仅可查看历史记录",
    });
  });

  it("fails closed when a frozen loading module has duplicate placements", async () => {
    harness.state.stageRows = [
      frozenStage(),
      frozenStage({
        target_module_state_id: "module-loading-duplicate",
        target_step_key: "custom_loading_duplicate",
        target_step_name: "重复装车节点",
        target_step_sort_order: 61,
      }),
    ];

    const [order] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    expect(order).toMatchObject({
      loadingStageAvailable: false,
      loadingStageReason: "冻结工作流中的装车与出库模块存在重复节点配置，请联系管理员修复",
    });
  });

  it("fails closed when the frozen current step or loading module state is not executable", async () => {
    harness.state.stageRows = [frozenStage({ current_step_status: "completed" })];
    const [invalidCurrent] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);
    harness.state.stageRows = [frozenStage({ target_module_status: "blocked" })];
    const [blockedModule] = await loadLoadingBatchWorkflowOrders("org-1", ["order-1"]);

    expect(invalidCurrent).toMatchObject({
      loadingStageAvailable: false,
      loadingStageReason: "冻结工作流中的装车与出库节点无效，请联系管理员修复",
    });
    expect(blockedModule).toMatchObject({
      loadingStageAvailable: false,
      loadingStageReason: "“自定义装车”办理模块当前被阻断，请先处理异常",
    });
  });
});
