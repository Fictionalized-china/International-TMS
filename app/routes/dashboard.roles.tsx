import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/dashboard.roles";
import { requireSessionUser } from "../lib/auth.server";
import { validateCode, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";

type RoleRow = { id: string; code: string; name: string; description: string | null; is_system: number; permissions: string | null; member_count: number };
type PermissionRow = { code: string; module: string; name: string; description: string };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "role.view");
  const [roles, permissions] = await Promise.all([
    env.DB.prepare(`SELECT r.id, r.code, r.name, r.description, r.is_system, GROUP_CONCAT(rp.permission_code) AS permissions, COUNT(DISTINCT mr.membership_id) AS member_count FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN membership_roles mr ON mr.role_id = r.id WHERE r.organization_id = ? GROUP BY r.id ORDER BY r.is_system DESC, r.name`).bind(current.organizationId).all<RoleRow>(),
    env.DB.prepare("SELECT code, module, name, description FROM permissions ORDER BY module, code").all<PermissionRow>(),
  ]);
  return { current, roles: roles.results, permissions: permissions.results };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "role.manage");
  const form = await request.formData();
  const name = valueOf(form, "name"), code = valueOf(form, "code").toLowerCase(), description = valueOf(form, "description");
  const selected = form.getAll("permissions").filter((item): item is string => typeof item === "string");
  const errors: Record<string, string> = {};
  if (name.length < 2 || name.length > 50) errors.name = "角色名称需要 2-50 个字符";
  const codeError = validateCode(code); if (codeError) errors.code = codeError;
  if (!selected.length) errors.permissions = "至少选择一项权限";
  const known = await env.DB.prepare(`SELECT code FROM permissions WHERE code IN (${selected.map(() => "?").join(",") || "''"})`).bind(...selected).all<{ code: string }>();
  if (known.results.length !== selected.length) errors.permissions = "权限选项无效";
  if (Object.keys(errors).length) return { errors, values: { name, code, description, permissions: selected } };
  const exists = await env.DB.prepare("SELECT id FROM roles WHERE organization_id = ? AND code = ?").bind(current.organizationId, code).first();
  if (exists) return { formError: "角色代码已经存在", values: { name, code, description, permissions: selected } };
  const roleId = crypto.randomUUID(), now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO roles (id, organization_id, code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(roleId, current.organizationId, code, name, description || null, now, now),
    ...selected.map(permission => env.DB.prepare("INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)").bind(roleId, permission)),
  ]);
  await writeAudit({ request, action: "role.create", resourceType: "role", resourceId: roleId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { code, permissions: selected } });
  return { success: "角色已创建" };
}

export function meta() { return [{ title: "角色权限 | International TMS" }]; }

export default function Roles({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const grouped = loaderData.permissions.reduce<Record<string, PermissionRow[]>>((groups, permission) => {
    (groups[permission.module] ??= []).push(permission);
    return groups;
  }, {});
  const canManage = loaderData.current.permissions.includes("role.manage");
  return <><header className="page-header"><div><p className="eyebrow">ACCESS CONTROL</p><h1>角色权限</h1><p>用角色组合权限，再将角色授予组织成员。</p></div>{canManage && <Modal title="创建角色" triggerLabel="新增角色" closeSignal={actionData?.success} size="wide"><Form method="post" className="form-grid compact"><label className="field"><span>角色名称</span><input name="name" required defaultValue={actionData?.values?.name}/>{actionData?.errors?.name && <small className="field-error">{actionData.errors.name}</small>}</label><label className="field"><span>角色代码</span><input name="code" required placeholder="operator" defaultValue={actionData?.values?.code}/>{actionData?.errors?.code && <small className="field-error">{actionData.errors.code}</small>}</label><label className="field span-2"><span>说明</span><input name="description" defaultValue={actionData?.values?.description}/></label><fieldset className="permission-grid span-2"><legend>权限</legend>{Object.entries(grouped).map(([module, items]) => <div key={module}><strong>{{ identity: "组织与安全", dashboard: "工作台", master: "基础数据", crm: "客户管理", sales: "销售管理", quote: "询价报价", order: "运输订单", shipment: "运单轨迹", billing: "应收账单" }[module] ?? module}</strong>{items.map(p => <label key={p.code}><input type="checkbox" name="permissions" value={p.code} defaultChecked={actionData?.values?.permissions?.includes(p.code)}/><span><b>{p.name}</b><small>{p.description}</small></span></label>)}</div>)}</fieldset>{actionData?.errors?.permissions && <p className="field-error span-2">{actionData.errors.permissions}</p>}<button className="primary" disabled={busy}>创建角色</button></Form></Modal>}</header>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    <section className="cards">{loaderData.roles.map(role => <article className="role-card" key={role.id}><div><span className="status-pill">{role.is_system ? "系统角色" : "自定义"}</span><h3>{role.name}</h3><code>{role.code}</code><p>{role.description || "暂无说明"}</p></div><footer><span>{role.permissions?.split(",").length ?? 0} 项权限</span><span>{role.member_count} 位成员</span></footer></article>)}</section>
  </>;
}
