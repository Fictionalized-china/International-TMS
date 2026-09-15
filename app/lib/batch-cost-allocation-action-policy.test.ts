import { describe, expect, it } from "vitest";
import {
  resolveBatchCostAllocationActionPolicy,
  type BatchCostAllocationGateRow,
} from "./batch-cost-allocation-action-policy";

function row(overrides: Partial<BatchCostAllocationGateRow> = {}): BatchCostAllocationGateRow {
  return {
    order_id: "order-1",
    order_number: "SO-1",
    business_type: "ltl",
    order_status: "in_execution",
    batch_status: "loading",
    batch_approval_status: "approved",
    batch_actual_departure_at: null,
    workflow_instance_id: "instance-1",
    matched_instance_id: "instance-1",
    workflow_instance_status: "active",
    current_step_key: "outbound",
    current_step_name: "装车出库",
    current_step_status: "active",
    current_step_sort_order: 70,
    current_step_count: 1,
    cost_allocation_field_count: 1,
    loading_cost_allocation_field_count: 1,
    active_cost_allocation_field_count: 1,
    cost_allocation_required: 0,
    cost_allocation_step_key: "loading",
    cost_allocation_step_name: "配载装车",
    cost_allocation_step_sort_order: 60,
    cost_allocation_step_count: 1,
    loading_module_count: 1,
    target_loading_module_count: 1,
    target_loading_module_status: "completed",
    final_cost_step_key: "settlement",
    final_cost_step_name: "费用结算",
    final_cost_step_sort_order: 100,
    final_cost_step_count: 1,
    costs_instance_count: 1,
    costs_enabled: 1,
    costs_status: "in_progress",
    payable_confirmed: 0,
    payable_business_reviewed: 0,
    payable_finance_reviewed: 0,
    payable_business_locked: 0,
    payable_finance_locked: 0,
    dispatched: 1,
    actual_exit_recorded: 0,
    ...overrides,
  };
}

describe("batch cost allocation frozen action policy", () => {
  it("allows different valid target nodes after every order reaches its own field", () => {
    const result = resolveBatchCostAllocationActionPolicy([
      row(),
      row({
        order_id: "order-2",
        order_number: "SO-2",
        workflow_instance_id: "instance-2",
        matched_instance_id: "instance-2",
        cost_allocation_step_key: "custom-loading",
        cost_allocation_step_name: "自定义成本分摊",
        cost_allocation_step_sort_order: 65,
      }),
    ]);
    expect(result).toMatchObject({ editable: true, visible: true });
  });

  it.each([
    ["wrong module", { cost_allocation_field_count: 2, loading_cost_allocation_field_count: 1 }, "错误模块"],
    ["duplicate field", { cost_allocation_field_count: 2, loading_cost_allocation_field_count: 2 }, "重复"],
    ["missing field", { cost_allocation_field_count: 0, loading_cost_allocation_field_count: 0 }, "未配置"],
    ["hidden field", { active_cost_allocation_field_count: 0 }, "隐藏"],
    ["duplicate loading", { loading_module_count: 2 }, "重复"],
    ["non active instance", { workflow_instance_status: "completed" }, "未有效绑定"],
    ["ambiguous current", { current_step_count: 2 }, "无法唯一定位"],
    ["before field", { current_step_sort_order: 50 }, "开放成本分摊"],
    ["past costs", { current_step_sort_order: 110 }, "已越过最终费用节点"],
    ["closed costs", { costs_status: "completed" }, "已关闭"],
    ["signed payable", { payable_finance_reviewed: 1 }, "已有确认"],
    ["not dispatched", { dispatched: 0 }, "尚未完成装车出库"],
    ["after exit", { actual_exit_recorded: 1 }, "已登记实际出境"],
    ["batch departed", { batch_actual_departure_at: "2026-09-06T01:00:00Z" }, "已实际出境"],
    ["batch unapproved", { batch_approval_status: "submitted" }, "未审核通过"],
    ["ftl", { business_type: "ftl" }, "整车订单"],
  ] as const)("fails closed for %s", (_name, changes, message) => {
    const result = resolveBatchCostAllocationActionPolicy([row(changes)]);
    expect(result.editable).toBe(false);
    expect(result.reason).toContain(message);
  });

  it("uses whole-batch AND and includes the blocked order number", () => {
    const result = resolveBatchCostAllocationActionPolicy([
      row(),
      row({ order_id: "order-2", order_number: "SO-BLOCKED", dispatched: 0 }),
    ]);
    expect(result.editable).toBe(false);
    expect(result.reason).toContain("SO-BLOCKED");
  });

  it("evaluates every mounted order so hidden and required modes are order-independent", () => {
    const result = resolveBatchCostAllocationActionPolicy([
      row(),
      row({
        order_id: "order-hidden",
        order_number: "SO-HIDDEN",
        active_cost_allocation_field_count: 0,
      }),
      row({
        order_id: "order-required",
        order_number: "SO-REQUIRED",
        cost_allocation_required: 1,
      }),
    ]);
    expect(result).toMatchObject({ editable: false, visible: false, required: true });
    expect(result.orderReasons).toMatchObject({
      "order-1": "",
      "order-hidden": "冻结工作流已隐藏成本分摊字段",
      "order-required": "",
    });
  });

  it("retains required mode so actual-exit readiness can block until confirmed", () => {
    expect(resolveBatchCostAllocationActionPolicy([
      row({ cost_allocation_required: 1 }),
    ])).toMatchObject({ editable: true, required: true });
  });
});
