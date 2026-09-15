export type BatchCostAllocationGateRow = {
  order_id: string;
  order_number: string;
  business_type: string;
  order_status: string;
  batch_status: string;
  batch_approval_status: string;
  batch_actual_departure_at: string | null;
  workflow_instance_id: string | null;
  matched_instance_id: string | null;
  workflow_instance_status: string | null;
  current_step_key: string | null;
  current_step_name: string | null;
  current_step_status: string | null;
  current_step_sort_order: number | null;
  current_step_count: number;
  cost_allocation_field_count: number;
  loading_cost_allocation_field_count: number;
  active_cost_allocation_field_count: number;
  cost_allocation_required: number;
  cost_allocation_step_key: string | null;
  cost_allocation_step_name: string | null;
  cost_allocation_step_sort_order: number | null;
  cost_allocation_step_count: number;
  loading_module_count: number;
  target_loading_module_count: number;
  target_loading_module_status: string | null;
  final_cost_step_key: string | null;
  final_cost_step_name: string | null;
  final_cost_step_sort_order: number | null;
  final_cost_step_count: number;
  costs_instance_count: number;
  costs_enabled: number;
  costs_status: string | null;
  payable_confirmed: number;
  payable_business_reviewed: number;
  payable_finance_reviewed: number;
  payable_business_locked: number;
  payable_finance_locked: number;
  dispatched: number;
  actual_exit_recorded: number;
};

export type BatchCostAllocationActionPolicy = {
  configured: boolean;
  visible: boolean;
  editable: boolean;
  required: boolean;
  reason: string | null;
  orderReasons: Readonly<Record<string, string>>;
};

/**
 * Cost allocation is a batch mutation but its business permission is frozen on
 * each child order.  Every child must independently pass this resolver.  No
 * mutable workflow template or legacy fallback participates in the decision.
 */
export function resolveBatchCostAllocationActionPolicy(
  rows: readonly BatchCostAllocationGateRow[],
): BatchCostAllocationActionPolicy {
  if (!rows.length) {
    return {
      configured: false,
      visible: false,
      editable: false,
      required: false,
      reason: "配载单没有可办理费用分摊的有效挂载订单",
      orderReasons: {},
    };
  }

  const reasons: Record<string, string> = {};
  let allConfigured = true;
  let allVisible = true;
  let anyRequired = false;
  let firstBlocked: { label: string; reason: string } | null = null;
  for (const row of rows) {
    const label = row.order_number || row.order_id;
    const rowConfigured = row.cost_allocation_field_count === 1 &&
      row.loading_cost_allocation_field_count === 1;
    allConfigured = allConfigured && rowConfigured;
    anyRequired ||= row.cost_allocation_required === 1;
    let issue: { reason: string; visible: boolean } | null = null;
    const fail = (reason: string, visible = true) => {
      issue ??= { reason, visible };
    };
    if (row.business_type !== "ltl") fail("整车订单不能参与拼车成本分摊");
    else if (row.batch_status === "cancelled" || row.batch_approval_status !== "approved")
      fail("配载单未审核通过或已经取消，不能办理成本分摊");
    else if (row.batch_actual_departure_at)
      fail("配载单已实际出境，不能再新增、调整或确认成本分摊");
    else if (["completed", "cancelled"].includes(row.order_status))
      fail("订单已完结或取消，当前仅可查看历史费用");
    else if (
      !row.workflow_instance_id ||
      !row.matched_instance_id ||
      row.workflow_instance_id !== row.matched_instance_id ||
      row.workflow_instance_status !== "active"
    ) fail("冻结工作流实例未有效绑定，费用分摊已阻断");
    else if (
      row.current_step_count !== 1 ||
      !row.current_step_key ||
      row.current_step_status !== "active" ||
      row.current_step_sort_order === null
    ) fail("冻结工作流当前节点无法唯一定位，费用分摊已阻断");
    else if (row.cost_allocation_field_count === 0)
      fail("冻结工作流未配置 loading.cost_allocation，不能办理", false);
    else if (
      row.cost_allocation_field_count !== 1 ||
      row.loading_cost_allocation_field_count !== 1
    ) fail("cost_allocation 字段存在重复或绑定到错误模块，不能办理");
    else if (row.active_cost_allocation_field_count !== 1)
      fail("冻结工作流已隐藏成本分摊字段", false);
    else if (
      !row.cost_allocation_step_key ||
      row.cost_allocation_step_count !== 1 ||
      row.cost_allocation_step_sort_order === null
    ) fail("成本分摊字段的冻结目标节点不存在或不唯一");
    else if (row.loading_module_count !== 1)
      fail("冻结工作流的 loading 模块缺失或存在重复配置");
    else if (row.target_loading_module_count !== 1)
      fail(`“${row.cost_allocation_step_name ?? row.cost_allocation_step_key}”缺少唯一 loading 模块`);
    else if (row.target_loading_module_status === "blocked")
      fail(`“${row.cost_allocation_step_name ?? row.cost_allocation_step_key}”办理模块当前被阻断`);
    else if (
      !row.final_cost_step_key ||
      row.final_cost_step_sort_order === null ||
      row.final_cost_step_count !== 1
    ) fail("冻结工作流缺少可唯一定位的最终费用节点");
    else if (
      row.costs_instance_count !== 1 ||
      row.costs_enabled !== 1 ||
      !row.costs_status ||
      ["completed", "not_applicable", "blocked"].includes(row.costs_status)
    ) fail("费用模块未开放、已关闭或正被阻断");
    else if (
      row.payable_confirmed || row.payable_business_reviewed ||
      row.payable_finance_reviewed || row.payable_business_locked ||
      row.payable_finance_locked
    ) fail("应付费用已有确认、审核或锁定结果，不能再变更配载成本");
    else if (row.current_step_sort_order < row.cost_allocation_step_sort_order)
      fail(`进入“${row.cost_allocation_step_name ?? row.cost_allocation_step_key}”后开放成本分摊`);
    else if (
      row.current_step_key !== row.cost_allocation_step_key &&
      row.current_step_sort_order === row.cost_allocation_step_sort_order
    ) fail("冻结工作流节点顺序冲突，不能判断成本分摊办理时点");
    else if (row.current_step_sort_order > row.final_cost_step_sort_order)
      fail(`已越过最终费用节点“${row.final_cost_step_name ?? row.final_cost_step_key}”，不能再变更配载成本`);
    else if (
      row.current_step_key !== row.final_cost_step_key &&
      row.current_step_sort_order === row.final_cost_step_sort_order
    ) fail("最终费用节点与当前节点顺序冲突，费用分摊已阻断");
    else if (row.actual_exit_recorded)
      fail("已登记实际出境，不能再新增、调整或确认配载成本");
    else if (!row.dispatched)
      fail("尚未完成装车出库，全部挂载订单出库后才能办理");

    const resolvedIssue = issue as { reason: string; visible: boolean } | null;
    reasons[row.order_id] = resolvedIssue?.reason ?? "";
    if (resolvedIssue) {
      allVisible = allVisible && resolvedIssue.visible;
      firstBlocked ??= { label, reason: resolvedIssue.reason };
    }
  }

  if (firstBlocked) {
    return {
      configured: allConfigured,
      visible: allVisible,
      editable: false,
      required: anyRequired,
      reason: `订单 ${firstBlocked.label}：${firstBlocked.reason}`,
      orderReasons: reasons,
    };
  }

  return {
    configured: allConfigured,
    visible: allVisible,
    editable: true,
    required: anyRequired,
    reason: null,
    orderReasons: reasons,
  };
}
