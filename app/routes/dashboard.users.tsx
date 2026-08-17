import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/dashboard.users";
import { requireSessionUser } from "../lib/auth.server";
import { hashPassword } from "../lib/crypto.server";
import { validateEmail, validatePassword, valueOf, type FieldErrors } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";

type MemberRow = { membership_id: string; user_id: string; display_name: string; email: string; title: string | null; department_id:string|null; department_name:string|null; status: string; roles: string | null; role_ids: string | null; last_login_at: string | null };
type Department = { id:string; parent_id:string|null; name:string; status:string; sort_order:number };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "user.view");
  const [members,roles,departments] = await Promise.all([
    env.DB.prepare(`SELECT m.id AS membership_id, u.id AS user_id, u.display_name, u.email, m.title, m.department_id, d.name AS department_name, m.status, u.last_login_at, GROUP_CONCAT(r.name, '、') AS roles, GROUP_CONCAT(r.id) AS role_ids FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id LEFT JOIN membership_roles mr ON mr.membership_id = m.id LEFT JOIN roles r ON r.id = mr.role_id WHERE m.organization_id = ? GROUP BY m.id ORDER BY u.display_name`).bind(current.organizationId).all<MemberRow>(),
    env.DB.prepare("SELECT id, name FROM roles WHERE organization_id = ? ORDER BY name").bind(current.organizationId).all<{ id: string; name: string }>(),
    env.DB.prepare("SELECT id,parent_id,name,status,sort_order FROM departments WHERE organization_id=? ORDER BY sort_order,name").bind(current.organizationId).all<Department>(),
  ]);
  return { current, members: members.results, roles: roles.results, departments:departments.results };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "user.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  if (intent === "role") {
    const membershipId = valueOf(form, "membershipId"), roleId = valueOf(form, "roleId");
    const valid = await env.DB.prepare("SELECT m.id FROM memberships m JOIN roles r ON r.organization_id = m.organization_id WHERE m.id = ? AND r.id = ? AND m.organization_id = ?").bind(membershipId, roleId, current.organizationId).first();
    if (!valid) return { formError: "成员或角色无效" };
    await env.DB.batch([
      env.DB.prepare("DELETE FROM membership_roles WHERE membership_id = ?").bind(membershipId),
      env.DB.prepare("INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)").bind(membershipId, roleId),
    ]);
    await writeAudit({ request, action: "membership.role.assign", resourceType: "membership", resourceId: membershipId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { roleId } });
    return { success: "成员角色已更新" };
  }
  if (intent === "department") {
    const membershipId=valueOf(form,"membershipId"),departmentId=valueOf(form,"departmentId")||null;
    const membership=await env.DB.prepare("SELECT id FROM memberships WHERE id=? AND organization_id=?").bind(membershipId,current.organizationId).first();
    const department=departmentId?await env.DB.prepare("SELECT id FROM departments WHERE id=? AND organization_id=? AND status='active'").bind(departmentId,current.organizationId).first():true;
    if(!membership||!department)return{formError:"成员或部门无效"};
    await env.DB.prepare("UPDATE memberships SET department_id=?,updated_at=? WHERE id=? AND organization_id=?").bind(departmentId,new Date().toISOString(),membershipId,current.organizationId).run();
    await writeAudit({request,action:"membership.department.assign",resourceType:"membership",resourceId:membershipId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{departmentId}});
    return{success:"用户部门已更新"};
  }
  if (intent === "toggle") {
    const membershipId = valueOf(form, "membershipId");
    const membership = await env.DB.prepare("SELECT user_id, status FROM memberships WHERE id = ? AND organization_id = ?").bind(membershipId, current.organizationId).first<{ user_id: string; status: string }>();
    if (!membership || membership.user_id === current.userId) return { formError: "不能停用当前登录用户" };
    const next = membership.status === "active" ? "disabled" : "active";
    await env.DB.prepare("UPDATE memberships SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(next, new Date().toISOString(), membershipId, current.organizationId).run();
    await writeAudit({ request, action: `membership.${next}`, resourceType: "membership", resourceId: membershipId, organizationId: current.organizationId, actorUserId: current.userId });
    return { success: "用户状态已更新" };
  }

  const displayName = valueOf(form, "displayName");
  const email = valueOf(form, "email").toLowerCase();
  const password = valueOf(form, "password");
  const title = valueOf(form, "title");
  const roleId = valueOf(form, "roleId");
  const departmentId=valueOf(form,"departmentId")||null;
  const errors: FieldErrors = {};
  if (displayName.length < 2 || displayName.length > 80) errors.displayName = "姓名需要 2-80 个字符";
  const emailError = validateEmail(email); if (emailError) errors.email = emailError;
  const passwordError = validatePassword(password); if (passwordError) errors.password = passwordError;
  const role = await env.DB.prepare("SELECT id FROM roles WHERE id = ? AND organization_id = ?").bind(roleId, current.organizationId).first();
  if (!role) errors.roleId = "请选择有效角色";
  const department=departmentId?await env.DB.prepare("SELECT id FROM departments WHERE id=? AND organization_id=? AND status='active'").bind(departmentId,current.organizationId).first():true;
  if(!department)errors.departmentId="请选择有效部门";
  if (Object.keys(errors).length) return { errors, values: { displayName, email, title, roleId,departmentId:departmentId??"" } };
  const duplicate = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (duplicate) return { formError: "该邮箱已经存在；跨组织用户关联将在后续版本提供", values: { displayName, email, title, roleId,departmentId:departmentId??"" } };
  const now = new Date().toISOString(), userId = crypto.randomUUID(), membershipId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(userId, email, await hashPassword(password), displayName, now, now),
    env.DB.prepare("INSERT INTO memberships (id, organization_id, user_id, title, department_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(membershipId, current.organizationId, userId, title || null,departmentId, now, now),
    env.DB.prepare("INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)").bind(membershipId, roleId),
  ]);
  await writeAudit({ request, action: "user.create", resourceType: "user", resourceId: userId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { email } });
  return { success: "用户已创建" };
}

export function meta() { return [{ title: "用户管理 | International TMS" }]; }

export default function Users({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canManage = loaderData.current.permissions.includes("user.manage");
  const departmentOptions=departmentTree(loaderData.departments);
  return <><header className="page-header"><div><p className="eyebrow">IDENTITY</p><h1>用户管理</h1><p>管理当前组织的成员、部门、岗位和状态。</p></div>{canManage && <Modal title="创建用户" triggerLabel="新增用户" closeSignal={actionData?.success}><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="create"/><label className="field"><span>姓名</span><input name="displayName" required defaultValue={actionData?.values?.displayName}/>{actionData?.errors?.displayName && <small className="field-error">{actionData.errors.displayName}</small>}</label><label className="field"><span>邮箱</span><input name="email" type="email" required defaultValue={actionData?.values?.email}/>{actionData?.errors?.email && <small className="field-error">{actionData.errors.email}</small>}</label><label className="field"><span>部门</span><select name="departmentId" defaultValue={actionData?.values?.departmentId}><option value="">未分配</option>{departmentOptions.filter(d=>d.status==="active").map(d=><option key={d.id} value={d.id}>{`${"　".repeat(d.level)}${d.name}`}</option>)}</select>{actionData?.errors?.departmentId&&<small className="field-error">{actionData.errors.departmentId}</small>}</label><label className="field"><span>岗位</span><input name="title" defaultValue={actionData?.values?.title}/></label><label className="field"><span>角色</span><select name="roleId" required defaultValue={actionData?.values?.roleId}><option value="">请选择</option>{loaderData.roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>{actionData?.errors?.roleId && <small className="field-error">{actionData.errors.roleId}</small>}</label><label className="field span-2"><span>初始密码</span><input name="password" type="password" required/><small className={actionData?.errors?.password ? "field-error" : ""}>{actionData?.errors?.password ?? "至少 12 位，包含大小写字母和数字"}</small></label><button className="primary" disabled={busy}>创建用户</button></Form></Modal>}</header>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    <section className="panel"><h2>组织成员</h2><div className="table-wrap"><table><thead><tr><th>成员</th><th>部门</th><th>岗位</th><th>角色</th><th>最近登录</th><th>状态</th><th></th></tr></thead><tbody>{loaderData.members.map(m => <tr key={m.membership_id}><td><strong>{m.display_name}</strong><small>{m.email}</small></td><td>{canManage?<Form method="post" className="inline-form"><input type="hidden" name="intent" value="department"/><input type="hidden" name="membershipId" value={m.membership_id}/><select name="departmentId" defaultValue={m.department_id||""}><option value="">未分配</option>{departmentOptions.filter(d=>d.status==="active").map(d=><option key={d.id} value={d.id}>{`${"　".repeat(d.level)}${d.name}`}</option>)}</select><button className="text-button">保存</button></Form>:m.department_name||"未分配"}</td><td>{m.title || "—"}</td><td>{loaderData.current.permissions.includes("user.manage") ? <Form method="post" className="inline-form"><input type="hidden" name="intent" value="role"/><input type="hidden" name="membershipId" value={m.membership_id}/><select name="roleId" defaultValue={m.role_ids?.split(",")[0] || ""}>{loaderData.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select><button className="text-button">分配</button></Form> : m.roles || "未分配"}</td><td>{m.last_login_at ? new Date(m.last_login_at).toLocaleString("zh-CN") : "从未"}</td><td><span className={`status-pill ${m.status !== "active" ? "off" : ""}`}>{m.status === "active" ? "有效" : "已停用"}</span></td><td>{loaderData.current.permissions.includes("user.manage") && m.user_id !== loaderData.current.userId && <Form method="post"><input type="hidden" name="intent" value="toggle"/><input type="hidden" name="membershipId" value={m.membership_id}/><button className="text-button">{m.status === "active" ? "停用" : "恢复"}</button></Form>}</td></tr>)}</tbody></table></div></section>
  </>;
}

function departmentTree(departments:Department[]){const children=new Map<string|null,Department[]>();for(const department of departments){const group=children.get(department.parent_id)??[];group.push(department);children.set(department.parent_id,group);}const result:Array<Department&{level:number}>=[],visited=new Set<string>();const visit=(parent:string|null,level:number)=>{for(const department of children.get(parent)??[]){if(visited.has(department.id))continue;visited.add(department.id);result.push({...department,level});visit(department.id,level+1);}};visit(null,0);for(const department of departments)if(!visited.has(department.id))result.push({...department,level:0});return result;}
