import { describe, expect, it } from "vitest";
import {
  batchCostAllocationGateError,
  type BatchCostAllocationGateRow,
} from "./cost-allocation.server";

function row(overrides:Partial<BatchCostAllocationGateRow>={}):BatchCostAllocationGateRow{
  return {
    order_id:"order-1",
    order_number:"SO-1",
    order_status:"in_execution",
    workflow_instance_id:"instance-1",
    matched_instance_id:"instance-1",
    current_step_sort_order:70,
    last_cost_step_sort_order:100,
    costs_status:"in_progress",
    confirmed:0,
    business_reviewed:0,
    finance_reviewed:0,
    business_locked:0,
    finance_locked:0,
    ...overrides,
  };
}

describe("batch cost allocation business gate",()=>{
  it("allows an open frozen costs module before its final placement",()=>{
    expect(batchCostAllocationGateError([row()])).toBeNull();
  });

  it.each(["completed","cancelled"])("blocks terminal order status %s",status=>{
    expect(batchCostAllocationGateError([row({order_status:status})]))
      .toContain("已完结或取消");
  });

  it("blocks a cross-order or dangling frozen instance binding",()=>{
    expect(batchCostAllocationGateError([row({matched_instance_id:null})]))
      .toContain("冻结工作流绑定");
  });

  it("blocks a frozen workflow without a costs placement",()=>{
    expect(batchCostAllocationGateError([row({last_cost_step_sort_order:null})]))
      .toContain("费用节点不完整");
  });

  it("blocks after the frozen costs placement has been passed",()=>{
    expect(batchCostAllocationGateError([row({current_step_sort_order:110})]))
      .toContain("已越过");
  });

  it.each(["completed","not_applicable"])("blocks closed costs module %s",status=>{
    expect(batchCostAllocationGateError([row({costs_status:status})]))
      .toContain("已经完成");
  });

  it.each([
    "confirmed",
    "business_reviewed",
    "finance_reviewed",
    "business_locked",
    "finance_locked",
  ] as const)("blocks when payable has %s",field=>{
    expect(batchCostAllocationGateError([row({[field]:1})]))
      .toContain("已有签核或锁定结果");
  });

  it("does not let one open order hide a blocked mounted order",()=>{
    expect(batchCostAllocationGateError([
      row(),
      row({order_id:"order-2",order_number:"SO-2",finance_locked:1}),
    ])).toContain("SO-2");
  });

  it("fails closed for an unbound legacy order because it has no frozen costs contract",()=>{
    expect(batchCostAllocationGateError([row({
      workflow_instance_id:null,
      matched_instance_id:null,
      current_step_sort_order:null,
      last_cost_step_sort_order:null,
    })])).toContain("冻结工作流绑定");
  });
});
