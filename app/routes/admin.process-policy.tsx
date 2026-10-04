import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.process-policy";
import { requireSessionUser } from "../lib/auth.server";
import { businessProcessPolicyDefinitions, dispatchOrderFieldCodes, type BusinessProcessPolicyKey } from "../lib/business-process-policy";
import { loadBusinessProcessPolicy, saveBusinessProcessPolicy } from "../lib/business-process-policy.server";
import { writeAudit } from "../lib/audit.server";

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "workflow.process_policy.manage");
  const [policy, customers, positions] = await Promise.all([
    loadBusinessProcessPolicy(current.organizationId),
    env.DB.prepare("SELECT id,name,cs_order_entry_enabled FROM customers WHERE organization_id=? AND status='active' ORDER BY name").bind(current.organizationId).all<{ id: string; name: string; cs_order_entry_enabled: number }>(),
    env.DB.prepare("SELECT code,name FROM positions WHERE organization_id=? AND status='active' ORDER BY sort_order").bind(current.organizationId).all<{ code: string; name: string }>(),
  ]);
  return { policy, customers: customers.results, positions: positions.results };
}
export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "workflow.process_policy.manage");
  const form = await request.formData();
  const values = Object.fromEntries(businessProcessPolicyDefinitions.map(d => [d.key, String(form.get(d.key) ?? "")])) as Record<BusinessProcessPolicyKey, string>;
  try {
    const customerIds = [...new Set(form.getAll("csCustomerIds").map(String))];
    const customers = await env.DB.prepare("SELECT id,cs_order_entry_enabled FROM customers WHERE organization_id=? AND status='active'").bind(current.organizationId).all<{ id: string; cs_order_entry_enabled: number }>();
    if (customerIds.some(id => !customers.results.some(c => c.id === id))) return { formError: "所选客户不属于当前组织或已停用" };
    const changes = customers.results.filter(c => Boolean(c.cs_order_entry_enabled) !== customerIds.includes(c.id));
    await saveBusinessProcessPolicy({ organizationId: current.organizationId, userId: current.userId, values,
      additionalStatements: changes.map(c => env.DB.prepare("UPDATE customers SET cs_order_entry_enabled=?,updated_at=? WHERE id=? AND organization_id=?")
        .bind(customerIds.includes(c.id) ? 1 : 0, new Date().toISOString(), c.id, current.organizationId)),
    });
    await writeAudit({ request, organizationId: current.organizationId, actorUserId: current.userId, action: "workflow.process_policy.update", resourceType: "business_process_policy", metadata: { values, csCustomerIds: customerIds } });
    return { success: "流程策略已保存；已通过节点和历史记录保留，当前及后续办理按新策略校验。" };
  } catch (error) { return { formError: error instanceof Error ? error.message : "配置保存失败" }; }
}
export default function ProcessPolicy({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const groups = [...new Set(businessProcessPolicyDefinitions.map(d => d.group))];
  return <div className="module-business-stack"><header className="page-header"><div><h1>业务流程策略</h1><p>岗位代码决定谁能办理，权限积木与订单责任范围仍独立校验。停用功能不删除历史数据。</p></div><Link className="secondary" to="/admin/workflow">返回业务工作流</Link></header>
    {actionData?.formError && <p className="alert danger" role="alert">{actionData.formError}</p>}
    {actionData?.success && <p className="alert success" role="status">{actionData.success}</p>}
    <Form method="post" className="stack">
      {groups.map(group => <fieldset className="panel" key={group}><legend>{group}</legend><div className="form-grid">{businessProcessPolicyDefinitions.filter(d => d.group === group).map(d => <label className="field" key={d.key}><span>{d.label}</span>{d.kind === "boolean" ? <select name={d.key} defaultValue={loaderData.policy[d.key]}><option value="1">启用</option><option value="0">停用</option></select> : <input name={d.key} defaultValue={loaderData.policy[d.key]} required={d.kind === "positions"} />}<small>{d.kind === "positions" ? "多个岗位用英文逗号分隔；不能留空。" : d.kind === "fees" ? "标准费用类别或实际费用代码，用英文逗号分隔；留空表示不限制类别。" : "仅控制此项能力，不扩大其他业务权限。"}</small></label>)}</div></fieldset>)}
      <fieldset className="panel"><legend>客服代录客户</legend><p>不以姓名推测客户身份；勾选实际业务客户后，客服才可代录其订单。</p><div className="form-grid">{loaderData.customers.map(c => <label key={c.id}><input type="checkbox" name="csCustomerIds" value={c.id} defaultChecked={Boolean(c.cs_order_entry_enabled)} /> {c.name}</label>)}</div></fieldset>
      <details className="panel"><summary>可选岗位代码</summary><p>{loaderData.positions.map(p => `${p.code}：${p.name}`).join("；")}</p></details>
      <details className="panel"><summary>找车资料字段代码</summary><p>{dispatchOrderFieldCodes.join("、")}</p><p>仅支持现有订单字段；不填写表示不增加额外资料门禁。</p></details>
      <button className="primary" disabled={busy}>保存流程策略</button>
    </Form></div>;
}
