export const operationalRuleDefinitions = [
  {
    code: "warehouse.receipt_difference_threshold_percent",
    label: "仓库实收异常阈值",
    description: "实收重量或体积与订单值的最大偏差超过该比例时，才进入费用影响确认。件数、包装不一致仍会直接提示。",
    defaultValue: 5,
    min: 0,
    max: 100,
    step: 0.1,
    unit: "%",
  },
  {
    code: "dispatch.find_vehicle_lead_days",
    label: "提前找车天数",
    description: "计划发车日前多少天开始进入调度找车提醒。",
    defaultValue: 3,
    min: 0,
    max: 90,
    step: 1,
    unit: "天",
  },
  {
    code: "loading.volume_weight_ratio_kg_per_cbm",
    label: "抛重换算比例",
    description: "按体积分摊时使用的重量换算比例；1 CBM 对应多少 KG。当前约定为 1:300。",
    defaultValue: 300,
    min: 1,
    max: 2000,
    step: 1,
    unit: "KG/CBM",
  },
  {
    code: "tracking.due_warning_hours",
    label: "到期前预警",
    description: "距离计划到达时间不足该小时数时显示即将到期。",
    defaultValue: 24,
    min: 1,
    max: 720,
    step: 1,
    unit: "小时",
  },
  {
    code: "tracking.stale_warning_hours",
    label: "运踪未更新预警",
    description: "运输任务超过该小时数没有新轨迹时显示久未更新。",
    defaultValue: 48,
    min: 1,
    max: 720,
    step: 1,
    unit: "小时",
  },
] as const;

export type OperationalRuleCode = typeof operationalRuleDefinitions[number]["code"];
export type OperationalRuleValues = Record<OperationalRuleCode, number>;

export const defaultOperationalRuleValues = Object.fromEntries(
  operationalRuleDefinitions.map((definition) => [definition.code, definition.defaultValue]),
) as OperationalRuleValues;

export function normalizeOperationalRuleValue(code: OperationalRuleCode, value: unknown) {
  const definition = operationalRuleDefinitions.find((item) => item.code === code);
  if (!definition) throw new Error(`Unknown operational rule: ${code}`);
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return definition.defaultValue;
  return Math.min(definition.max, Math.max(definition.min, parsed));
}

export function resolveOperationalRuleValues(
  rows: ReadonlyArray<{ rule_code: string; numeric_value: number | string | null }>,
): OperationalRuleValues {
  const values = { ...defaultOperationalRuleValues };
  for (const row of rows) {
    if (!operationalRuleDefinitions.some((item) => item.code === row.rule_code)) continue;
    const code = row.rule_code as OperationalRuleCode;
    values[code] = normalizeOperationalRuleValue(code, row.numeric_value);
  }
  return values;
}
