import { intakeRouteFields, type IntakeFieldPolicy, type IntakeRouteReference } from "../lib/intake-route-fields";

export function IntakeRouteFields({ references, policy, direct = false, values = {},editableKeys }: {
  references: readonly IntakeRouteReference[];
  policy: (key: string) => IntakeFieldPolicy;
  direct?: boolean;
  values?: Record<string, unknown>;
  editableKeys?:readonly string[];
}) {
  return <div className="quote-field-grid intake-route-fields">{intakeRouteFields.map(field => {
    const rule = policy(field.fieldKey);
    if (!direct && !rule.isActive) return null;
    const value = String(values[field.column] ?? "");
    const options = references.filter(row => row.category === field.category);
    if(editableKeys&&!editableKeys.includes(field.fieldKey))return <label className="field" key={field.fieldKey}><span>{field.label}{value.trim()?"（已记录）":"（待补录）"}</span><input className="control" readOnly value={options.find(row=>row.code===value)?.name??value}/></label>;
    return <label className="field" key={field.fieldKey}><span>{field.label}</span>{field.category
      ? <select className="control" name={field.formName} defaultValue={value} required={direct || rule.isRequired}>
        <option value="">请选择{field.label}</option>
        {value && !options.some(row => row.code === value) && <option value={value}>历史值：{value}</option>}
        {options.map(row => <option key={row.code} value={row.code}>{row.name} · {row.code}</option>)}
      </select>
      : <input className="control" name={field.formName} defaultValue={value} required={direct || rule.isRequired} maxLength={field.maxLength} placeholder="填写国内代理名称，与 RO 代理分别记录" />}
      {field.category && !options.length && !value && <small>暂无可选项，请由管理员补充对应基础数据后继续。</small>}
    </label>;
  })}</div>;
}
