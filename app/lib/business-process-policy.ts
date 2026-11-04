/** Cross-module business rules. Node/field hot-plug remains owned by workflows. */
export const businessProcessPolicyDefinitions = [
  { key: "order.submit_positions", label: "录单提交岗位（含紧急协助）", group: "录单与审核", kind: "positions", defaultValue: "SALES,CS,HR_ADMIN" },
  { key: "order.hr_emergency_enabled", label: "允许人事紧急协助录单（必须记录原因）", group: "录单与审核", kind: "boolean", defaultValue: "1" },
  { key: "order.approve_positions", label: "订单审核岗位", group: "录单与审核", kind: "positions", defaultValue: "OPERATION_SUPERVISOR" },
  { key: "order.cs_requires_customer_flag", label: "客服仅代录已配置客户", group: "录单与审核", kind: "boolean", defaultValue: "1" },
  { key: "order.ftl_required_fees", label: "整车开单必录费用代码", group: "录单与审核", kind: "fees", defaultValue: "pickup,handling,storage,customs_port,overseas_driver,transit_customs" },
  { key: "order.ltl_required_fees", label: "拼车开单必录费用代码", group: "录单与审核", kind: "fees", defaultValue: "pickup" },
  { key: "order.require_receivable", label: "开单必须录入应收", group: "录单与审核", kind: "boolean", defaultValue: "1" },
  { key: "order.ftl_require_payable", label: "整车开单必须录入应付", group: "录单与审核", kind: "boolean", defaultValue: "1" },
  { key: "tracking.daily_enabled", label: "启用全程每日运踪", group: "运踪与商务调度", kind: "boolean", defaultValue: "1" },
  { key: "tracking.positions", label: "每日运踪填写岗位", group: "运踪与商务调度", kind: "positions", defaultValue: "TRACKING" },
  { key: "dispatch.enabled", label: "启用找车任务", group: "运踪与商务调度", kind: "boolean", defaultValue: "1" },
  { key: "dispatch.request_positions", label: "发起找车岗位", group: "运踪与商务调度", kind: "positions", defaultValue: "OPERATION,OPERATION_SUPERVISOR,TRACKING" },
  { key: "dispatch.handler_positions", label: "找车办理岗位", group: "运踪与商务调度", kind: "positions", defaultValue: "BUSINESS_ROUTE" },
  { key: "dispatch.automatic", label: "资料齐全时自动生成找车任务", group: "运踪与商务调度", kind: "boolean", defaultValue: "1" },
  { key: "dispatch.required_order_fields", label: "找车前必备订单字段", group: "运踪与商务调度", kind: "fields", defaultValue: "shipper_name,shipper_contact,shipper_phone,origin_city,origin_address,consignee_name,destination_city,destination_address,cargo_description" },
  { key: "loading.automatic_cost_allocation", label: "生成配载单时自动关联子订单应付成本", group: "运踪与商务调度", kind: "boolean", defaultValue: "1" },
  { key: "tracking.alerts_enabled", label: "自动向业务与操作发送时效预警", group: "运踪与商务调度", kind: "boolean", defaultValue: "1" },
  { key: "settlement.after_actual_export", label: "实际出境后开放对账签核", group: "应收应付", kind: "boolean", defaultValue: "1" },
  { key: "settlement.sequential", label: "费用签核必须按顺序办理", group: "应收应付", kind: "boolean", defaultValue: "1" },
  { key: "settlement.approver_amounts_visible", label: "本单签核人可查看其审核方向的必要费用明细（不含毛利、银行资料）", group: "应收应付", kind: "boolean", defaultValue: "1" },
  { key: "settlement.require_cash_before_archive", label: "最终归档前必须完成对账及真实收付款核销（关闭才允许业务先归档）", group: "应收应付", kind: "boolean", defaultValue: "1" },
  { key: "receivable.initiator_positions", label: "应收发起岗位", group: "应收应付", kind: "positions", defaultValue: "SALES,CS" },
  { key: "receivable.review_positions", label: "应收复核岗位", group: "应收应付", kind: "positions", defaultValue: "OPERATION" },
  { key: "receivable.approve_positions", label: "应收审批岗位", group: "应收应付", kind: "positions", defaultValue: "OPERATION_SUPERVISOR" },
  { key: "receivable.statement_positions", label: "客户对账单生成岗位", group: "应收应付", kind: "positions", defaultValue: "CS" },
  { key: "payable.initiator_positions", label: "应付申请岗位", group: "应收应付", kind: "positions", defaultValue: "OPERATION,BUSINESS_ROUTE" },
  { key: "payable.review_positions", label: "应付部门审批岗位", group: "应收应付", kind: "positions", defaultValue: "OPERATION_SUPERVISOR" },
  { key: "payable.approve_positions", label: "应付财务审批岗位", group: "应收应付", kind: "positions", defaultValue: "FINANCE_ACCOUNTING" },
  { key: "payable.offline_approval_required", label: "付款前必须记录总经理线下审批", group: "应收应付", kind: "boolean", defaultValue: "1" },
  { key: "hr.reports_enabled", label: "启用人事回款及提成报表", group: "总览与人事", kind: "boolean", defaultValue: "1" },
] as const;

export type BusinessProcessPolicyKey = typeof businessProcessPolicyDefinitions[number]["key"];
export type BusinessProcessPolicy = Record<BusinessProcessPolicyKey, string>;
export const defaultBusinessProcessPolicy = Object.fromEntries(businessProcessPolicyDefinitions.map(d => [d.key, d.defaultValue])) as BusinessProcessPolicy;
export const dispatchOrderFieldCodes = ["shipper_name","shipper_contact","shipper_phone","origin_city","origin_address","consignee_name","consignee_contact","consignee_phone","destination_city","destination_address","cargo_description","exit_port","requested_pickup_date","overseas_warehouse_id"];

export function policyPositions(policy: BusinessProcessPolicy, key: BusinessProcessPolicyKey) {
  return policy[key].split(",").map(v => v.trim()).filter(Boolean);
}
export function policyEnabled(policy: BusinessProcessPolicy, key: BusinessProcessPolicyKey) { return policy[key] === "1"; }

export function validateBusinessProcessPolicy(values: Partial<Record<BusinessProcessPolicyKey, unknown>>) {
  const normalized: Partial<BusinessProcessPolicy> = {};
  for (const definition of businessProcessPolicyDefinitions) {
    if (!(definition.key in values)) continue;
    const value = String(values[definition.key] ?? "").trim();
    if (definition.kind === "boolean") {
      if (!["0", "1"].includes(value)) throw new Error(`${definition.label}必须为启用或停用`);
      normalized[definition.key] = value;
    } else {
      const codes = [...new Set(value.split(",").map(v => v.trim()).filter(Boolean))];
      if (definition.kind === "positions" && !codes.length) throw new Error(`${definition.label}不能为空，避免无人可办理`);
      if (codes.some(code => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code))) throw new Error(`${definition.label}包含无效代码`);
      if (definition.kind === "fields" && codes.some(code=>!dispatchOrderFieldCodes.includes(code))) throw new Error("找车字段代码不存在，请使用页面列出的订单字段，避免无法解除的门禁");
      normalized[definition.key] = codes.join(",");
    }
  }
  return normalized;
}

export function resolveBusinessProcessPolicy(rows: readonly { policy_key: string; policy_value: string }[]): BusinessProcessPolicy {
  const values = { ...defaultBusinessProcessPolicy };
  for (const row of rows) {
    const definition = businessProcessPolicyDefinitions.find(d => d.key === row.policy_key);
    if (!definition) continue;
    // Invalid persisted policies fail closed instead of granting broader defaults.
    Object.assign(values, validateBusinessProcessPolicy({ [definition.key]: row.policy_value }));
  }
  return values;
}
