import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/dashboard.users";
import { requireSessionUser } from "../lib/auth.server";
import { hashPassword } from "../lib/crypto.server";
import { validateEmail, validatePassword, valueOf, type FieldErrors } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { roleCodeForPosition } from "../lib/position-role";
import { isProtectedAccessRole } from "../lib/permission-blocks";
import { inspectAccessControlSchema } from "../lib/access-control-schema.server";
import { loadWorkflowPositionRemovalBlocker } from "../lib/workflow-position-coverage.server";

type MemberRow = { membership_id: string; user_id: string; display_name: string; email: string; title: string | null; department_id:string|null; department_name:string|null; position_id:string|null; position_name:string|null; status: string; roles: string | null; role_ids: string | null; role_codes: string | null; last_login_at: string | null };
type Department = { id:string; parent_id:string|null; name:string; status:string; sort_order:number };
type PositionOption = { id:string; code:string; name:string; department_id:string };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "user.view");
  const [members,departments,positions] = await Promise.all([
    env.DB.prepare(`SELECT m.id AS membership_id, u.id AS user_id, u.display_name, u.email, m.title, m.department_id, d.name AS department_name, m.position_id, p.name AS position_name, m.status, u.last_login_at, GROUP_CONCAT(r.name, '、') AS roles, GROUP_CONCAT(r.id) AS role_ids, GROUP_CONCAT(DISTINCT r.code) AS role_codes FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id LEFT JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id LEFT JOIN membership_roles mr ON mr.membership_id = m.id LEFT JOIN roles r ON r.id = mr.role_id WHERE m.organization_id = ? GROUP BY m.id ORDER BY d.sort_order,p.sort_order,u.display_name`).bind(current.organizationId).all<MemberRow>(),
    env.DB.prepare("SELECT id,parent_id,name,status,sort_order FROM departments WHERE organization_id=? ORDER BY sort_order,name").bind(current.organizationId).all<Department>(),
    env.DB.prepare(`SELECT p.id,p.code,p.name,d.id department_id FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code AND d.status='active' WHERE p.organization_id=? AND p.status='active' ORDER BY d.sort_order,p.sort_order,p.name`).bind(current.organizationId).all<PositionOption>(),
  ]);
  const canAssignProtectedPosition=isProtectedAccessRole(current.roleCodes);
  return { current, members: members.results, departments:departments.results, positions:positions.results.filter((position)=>canAssignProtectedPosition||!["BOSS","DEVELOPER"].includes(position.code)) };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "user.manage");
  const schema = await inspectAccessControlSchema(env.DB);
  if (!schema.ready) return { formError: `权限数据库升级尚未完成：${schema.missing.join("、")}。为保护账号，本次修改未执行。` };
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  if (intent === "role") {
    return { formError: "角色随岗位自动匹配；个人差异请在角色权限中配置账户权限积木" };
  }
  if (intent === "department") {
    const membershipId=valueOf(form,"membershipId"),positionId=valueOf(form,"positionId");
    const membership=await env.DB.prepare(`SELECT m.id,GROUP_CONCAT(DISTINCT r.code) role_codes FROM memberships m LEFT JOIN membership_roles mr ON mr.membership_id=m.id LEFT JOIN roles r ON r.id=mr.role_id WHERE m.id=? AND m.organization_id=? GROUP BY m.id`).bind(membershipId,current.organizationId).first<{id:string;role_codes:string|null}>();
    const placement=await env.DB.prepare(`SELECT p.id position_id,p.code position_code,p.name position_name,d.id department_id FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code AND d.status='active' WHERE p.id=? AND p.organization_id=? AND p.status='active'`).bind(positionId,current.organizationId).first<{position_id:string;position_code:string;position_name:string;department_id:string}>();
    if(!membership||!placement)return{formError:"请选择有效的部门和岗位"};
    if(isProtectedAccessRole((membership.role_codes??"").split(",").filter(Boolean)))return{formError:"老板/所有者账户的岗位和角色不可修改"};
    if(["BOSS","DEVELOPER"].includes(placement.position_code)&&!isProtectedAccessRole(current.roleCodes))return{formError:"只有老板/所有者可以分配受保护岗位"};
    const currentPlacement = await env.DB.prepare(
      "SELECT position_id FROM memberships WHERE id=? AND organization_id=?",
    ).bind(membershipId,current.organizationId).first<{position_id:string|null}>();
    if (currentPlacement?.position_id && currentPlacement.position_id !== placement.position_id) {
      const blocker = await loadWorkflowPositionRemovalBlocker(
        env.DB,
        current.organizationId,
        membershipId,
      );
      if (blocker) return { formError: blocker };
    }
    const roleCode=roleCodeForPosition(placement.position_code);
    const role=await env.DB.prepare("SELECT id FROM roles WHERE organization_id=? AND code=? AND status='active'").bind(current.organizationId,roleCode).first<{id:string}>();
    if(!role)return{formError:`岗位 ${placement.position_name} 尚未配置可用角色`};
    await env.DB.batch([
      env.DB.prepare("UPDATE memberships SET department_id=?,position_id=?,title=?,updated_at=? WHERE id=? AND organization_id=?").bind(placement.department_id,placement.position_id,placement.position_name,new Date().toISOString(),membershipId,current.organizationId),
      env.DB.prepare("DELETE FROM membership_roles WHERE membership_id=? AND role_id IN (SELECT id FROM roles WHERE organization_id=? AND (code LIKE 'pos_%' OR code IN ('boss','developer','warehouse_operator','overseas_warehouse_operator')))").bind(membershipId,current.organizationId),
      env.DB.prepare("INSERT OR IGNORE INTO membership_roles(membership_id,role_id) VALUES(?,?)").bind(membershipId,role.id),
    ]);
    await writeAudit({request,action:"membership.organization.assign",resourceType:"membership",resourceId:membershipId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{departmentId:placement.department_id,positionId:placement.position_id}});
    return{success:"用户的部门和岗位已更新"};
  }
  if (intent === "toggle") {
    const membershipId = valueOf(form, "membershipId");
    const membership = await env.DB.prepare("SELECT user_id, status FROM memberships WHERE id = ? AND organization_id = ?").bind(membershipId, current.organizationId).first<{ user_id: string; status: string }>();
    if (!membership || membership.user_id === current.userId) return { formError: "不能停用当前登录用户" };
    const protectedRoles=await env.DB.prepare(`SELECT GROUP_CONCAT(r.code) role_codes FROM membership_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.membership_id=?`).bind(membershipId).first<{role_codes:string|null}>();
    if(isProtectedAccessRole((protectedRoles?.role_codes??"").split(",").filter(Boolean)))return{formError:"老板/所有者账户不能停用"};
    if (membership.status === "active") {
      const blocker = await loadWorkflowPositionRemovalBlocker(
        env.DB,
        current.organizationId,
        membershipId,
      );
      if (blocker) return { formError: blocker };
    }
    const next = membership.status === "active" ? "disabled" : "active";
    await env.DB.prepare("UPDATE memberships SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(next, new Date().toISOString(), membershipId, current.organizationId).run();
    await writeAudit({ request, action: `membership.${next}`, resourceType: "membership", resourceId: membershipId, organizationId: current.organizationId, actorUserId: current.userId });
    return { success: "用户状态已更新" };
  }

  const displayName = valueOf(form, "displayName");
  const email = valueOf(form, "email").toLowerCase();
  const password = valueOf(form, "password");
  const positionId=valueOf(form,"positionId");
  const errors: FieldErrors = {};
  if (displayName.length < 2 || displayName.length > 80) errors.displayName = "姓名需要 2-80 个字符";
  const emailError = validateEmail(email); if (emailError) errors.email = emailError;
  const passwordError = validatePassword(password); if (passwordError) errors.password = passwordError;
  const placement=await env.DB.prepare(`SELECT p.id position_id,p.code position_code,p.name position_name,d.id department_id FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code AND d.status='active' WHERE p.id=? AND p.organization_id=? AND p.status='active'`).bind(positionId,current.organizationId).first<{position_id:string;position_code:string;position_name:string;department_id:string}>();
  if(!placement)errors.positionId="请选择有效的部门和岗位";
  const automaticRoleCode=placement?roleCodeForPosition(placement.position_code):"";
  if(placement&&["BOSS","DEVELOPER"].includes(placement.position_code)&&!isProtectedAccessRole(current.roleCodes))errors.positionId="只有老板/所有者可以创建受保护岗位账号";
  const role=automaticRoleCode?await env.DB.prepare("SELECT id FROM roles WHERE organization_id=? AND code=? AND status='active'").bind(current.organizationId,automaticRoleCode).first<{id:string}>():null;
  if(placement&&!role)errors.positionId=`岗位 ${placement.position_name} 尚未配置可用角色`;
  if (Object.keys(errors).length) return { errors, values: { displayName, email,departmentId:valueOf(form,"departmentId"),positionId } };
  const duplicate = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (duplicate) return { formError: "该邮箱已经存在；跨组织用户关联将在后续版本提供", values: { displayName, email,departmentId:valueOf(form,"departmentId"),positionId } };
  const now = new Date().toISOString(), userId = crypto.randomUUID(), membershipId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(userId, email, await hashPassword(password), displayName, now, now),
    env.DB.prepare("INSERT INTO memberships (id, organization_id, user_id, title, department_id, position_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(membershipId, current.organizationId, userId, placement!.position_name, placement!.department_id, placement!.position_id, now, now),
    env.DB.prepare("INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)").bind(membershipId, role!.id),
  ]);
  await writeAudit({ request, action: "user.create", resourceType: "user", resourceId: userId, organizationId: current.organizationId, actorUserId: current.userId, metadata: { email, departmentId: placement!.department_id, positionId: placement!.position_id } });
  return { success: "用户已创建" };
}

export function meta() { return [{ title: "用户管理 | International TMS" }]; }

export default function Users({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canManage = loaderData.current.permissions.includes("user.manage");
  const departmentOptions = departmentTree(loaderData.departments).filter(
    (department) => department.status === "active",
  );
  const values = actionData && "values" in actionData ? actionData.values : undefined;
  const errors = actionData && "errors" in actionData ? actionData.errors : undefined;
  const success = actionData && "success" in actionData ? actionData.success : undefined;
  const formError = actionData && "formError" in actionData ? actionData.formError : undefined;

  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">IDENTITY</p>
        <h1>用户管理</h1>
        <p>每个账号必须归属到“部门 → 岗位”，审核和派单才能准确落到个人。</p>
      </div>
      {canManage && <Modal title="创建用户" triggerLabel="新增用户" closeSignal={success}>
        <Form method="post" className="form-grid compact">
          <input type="hidden" name="intent" value="create"/>
          <label className="field">
            <span>姓名</span>
            <input name="displayName" required defaultValue={values?.displayName}/>
            {errors?.displayName && <small className="field-error">{errors.displayName}</small>}
          </label>
          <label className="field">
            <span>邮箱</span>
            <input name="email" type="email" required defaultValue={values?.email}/>
            {errors?.email && <small className="field-error">{errors.email}</small>}
          </label>
          <div className="field span-2">
            <span>组织归属</span>
            <OrganizationPlacementFields
              departments={departmentOptions}
              positions={loaderData.positions}
              defaultDepartmentId={values?.departmentId}
              defaultPositionId={values?.positionId}
            />
            {errors?.positionId && <small className="field-error">{errors.positionId}</small>}
          </div>
          <div className="field"><span>角色</span><p className="field-static-note">由所选岗位自动匹配；个人增减权限请前往“角色权限 → 账户权限积木”。</p></div>
          <label className="field span-2">
            <span>初始密码</span>
            <input name="password" type="password" required/>
            <small className={errors?.password ? "field-error" : ""}>
              {errors?.password ?? "至少 12 位，包含大小写字母和数字"}
            </small>
          </label>
          <button className="primary" disabled={busy}>创建用户</button>
        </Form>
      </Modal>}
    </header>

    {(success || formError) && (
      <div className={`alert ${formError ? "error" : "success"}`}>{formError ?? success}</div>
    )}

    <section className="panel">
      <h2>组织成员</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>成员</th><th colSpan={2}>组织归属（部门 → 岗位）</th><th>角色</th><th>最近登录</th><th>状态</th><th></th></tr></thead>
          <tbody>{loaderData.members.map((member) => {const protectedMember=isProtectedAccessRole((member.role_codes ?? "").split(",").filter(Boolean));return <tr key={member.membership_id}>
            <td><strong>{member.display_name}</strong><small>{member.email}</small></td>
            <td colSpan={2}>
              {canManage&&!protectedMember ? <Form method="post" className="member-placement-form">
                <input type="hidden" name="intent" value="department"/>
                <input type="hidden" name="membershipId" value={member.membership_id}/>
                <OrganizationPlacementFields
                  departments={departmentOptions}
                  positions={loaderData.positions}
                  defaultDepartmentId={member.department_id ?? ""}
                  defaultPositionId={member.position_id ?? ""}
                />
                <button className="text-button" disabled={busy}>保存归属</button>
              </Form> : `${member.department_name || "未分配"} / ${member.position_name || "未分配"}${protectedMember?" · 系统保护":""}`}
            </td>
            <td><strong>{member.roles || "未分配"}</strong><small>随岗位自动匹配；个人差异使用权限积木</small></td>
            <td>{member.last_login_at ? new Date(member.last_login_at).toLocaleString("zh-CN") : "从未"}</td>
            <td><span className={`status-pill ${member.status !== "active" ? "off" : ""}`}>{member.status === "active" ? "有效" : "已停用"}</span></td>
            <td>{canManage && !protectedMember && member.user_id !== loaderData.current.userId && <Form method="post">
              <input type="hidden" name="intent" value="toggle"/>
              <input type="hidden" name="membershipId" value={member.membership_id}/>
              <button className="text-button">{member.status === "active" ? "停用" : "恢复"}</button>
            </Form>}</td>
          </tr>})}</tbody>
        </table>
      </div>
    </section>
  </>;
}

function OrganizationPlacementFields({
  departments,
  positions,
  defaultDepartmentId = "",
  defaultPositionId = "",
}: {
  departments: Array<Department & { level: number }>;
  positions: PositionOption[];
  defaultDepartmentId?: string;
  defaultPositionId?: string;
}) {
  const initialDepartmentId = defaultDepartmentId ||
    positions.find((position) => position.id === defaultPositionId)?.department_id || "";
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [positionId, setPositionId] = useState(defaultPositionId);
  const availablePositions = positions.filter(
    (position) => position.department_id === departmentId,
  );

  return <div className="organization-placement-fields">
    <label>
      <span>部门</span>
      <select name="departmentId" required value={departmentId} onChange={(event) => {
        setDepartmentId(event.currentTarget.value);
        setPositionId("");
      }}>
        <option value="">选择部门</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>{`${"　".repeat(department.level)}${department.name}`}</option>
        ))}
      </select>
    </label>
    <span aria-hidden="true">→</span>
    <label>
      <span>岗位</span>
      <select name="positionId" required value={positionId} disabled={!departmentId} onChange={(event) => setPositionId(event.currentTarget.value)}>
        <option value="">选择岗位</option>
        {availablePositions.map((position) => (
          <option key={position.id} value={position.id}>{position.name}</option>
        ))}
      </select>
    </label>
  </div>;
}

function departmentTree(departments:Department[]){const children=new Map<string|null,Department[]>();for(const department of departments){const group=children.get(department.parent_id)??[];group.push(department);children.set(department.parent_id,group);}const result:Array<Department&{level:number}>=[],visited=new Set<string>();const visit=(parent:string|null,level:number)=>{for(const department of children.get(parent)??[]){if(visited.has(department.id))continue;visited.add(department.id);result.push({...department,level});visit(department.id,level+1);}};visit(null,0);for(const department of departments)if(!visited.has(department.id))result.push({...department,level:0});return result;}
