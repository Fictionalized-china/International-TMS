import { describe, expect, it, vi } from "vitest";
import { loadBatchCostAllocationActionPolicy } from "./batch-cost-allocation-action-policy.server";
import type { BatchCostAllocationGateRow } from "./batch-cost-allocation-action-policy";

const openRow = {
  order_id: "order-1", order_number: "SO-1", business_type: "ltl", order_status: "in_execution",
  batch_status: "loading", batch_approval_status: "approved", batch_actual_departure_at: null,
  workflow_instance_id: "wi-1", matched_instance_id: "wi-1", workflow_instance_status: "active",
  current_step_key: "outbound", current_step_name: "装车出库", current_step_status: "active",
  current_step_sort_order: 70, current_step_count: 1, cost_allocation_field_count: 1,
  loading_cost_allocation_field_count: 1, active_cost_allocation_field_count: 1,
  cost_allocation_required: 0, cost_allocation_step_key: "loading",
  cost_allocation_step_name: "配载装车", cost_allocation_step_sort_order: 60,
  cost_allocation_step_count: 1, loading_module_count: 1, target_loading_module_count: 1,
  target_loading_module_status: "completed", final_cost_step_key: "settlement",
  final_cost_step_name: "费用结算", final_cost_step_sort_order: 100, final_cost_step_count: 1,
  costs_instance_count: 1, costs_enabled: 1, costs_status: "in_progress",
  payable_confirmed: 0, payable_business_reviewed: 0, payable_finance_reviewed: 0,
  payable_business_locked: 0, payable_finance_locked: 0, dispatched: 1, actual_exit_recorded: 0,
} satisfies BatchCostAllocationGateRow;

describe("batch cost allocation policy loader", () => {
  it("binds the organization and batch and preserves whole-batch failure", async () => {
    const all = vi.fn(async () => ({ results: [openRow, { ...openRow, order_id: "order-2", order_number: "SO-2", dispatched: 0 }] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const result = await loadBatchCostAllocationActionPolicy({
      db: { prepare } as unknown as D1Database,
      organizationId: "org-1",
      batchId: "batch-1",
    });
    expect(bind).toHaveBeenCalledWith("org-1", "batch-1");
    expect(result.policy.editable).toBe(false);
    expect(result.policy.reason).toContain("SO-2");
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("item.organization_id=dispatch.organization_id");
    expect(sql).toContain("shipment.organization_id=package.organization_id");
    expect(sql).toContain("field.module_code='loading'");
  });
});
