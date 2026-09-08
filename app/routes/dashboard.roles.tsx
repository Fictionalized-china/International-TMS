import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/dashboard.roles";
import { requireSessionUser } from "../lib/auth.server";
import { validateCode, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { ActionToast } from "../components/ActionToast";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import {
  effectivePermissionCodes,
  isProtectedAccessRole,
  type PermissionOverride,
} from "../lib/permission-blocks";
import { inspectAccessControlSchema } from "../lib/access-control-schema.server";
import { canManageAccessConfiguration } from "../lib/access-configuration-authority";
import {
  normalizeWorkflowFieldHandlerPositionCodes,
  serializeWorkflowFieldHandlerPositionCodes,
  toggleWorkflowFieldHandlerPosition,
} from "../lib/workflow-field-position-access";
import { synchronizeWorkflowFieldHandlerPositionsForInstances } from "../lib/workflow-fields.server";
import type { OrderModuleCode } from "../lib/order-modules";

type RoleRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_system: number;
  status: "active" | "disabled";
  permissions: string | null;
  member_count: number;
};
type PermissionRow = { code: string; module: string; name: string; description: string };
type MemberRow = {
  membership_id: string;
  display_name: string;
  email: string;
  position_name: string | null;
  role_codes: string | null;
  role_names: string | null;
  inherited_permissions: string | null;
  override_entries: string | null;
};
type PositionRow = {
  code: string;
  name: string;
  department_name: string;
};
type WorkflowFieldPermissionRow = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  version_number: number;
  step_key: string;
  step_name: string;
  module_code: OrderModuleCode;
  module_name: string;
  field_key: string;
  field_label: string;
  handler_position_codes: string | null;
};

const moduleLabels: Record<string, string> = {
  identity: "组织、账号与安全",
  dashboard: "工作台",
  master: "基础数据",
  crm: "客户与客商",
  sales: "销售",
  quote: "询价报价",
  order: "运输订单与业务节点",
  shipment: "运单与运踪",
  warehouse: "仓库作业",
  carrier: "承运资源",
  pricing: "产品与价格",
  billing: "费用与结算",
  analytics: "统计、利润与导出",
  driver: "司机状态",
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "role.view");
  const schema = await inspectAccessControlSchema(env.DB);
  if (!schema.ready) {
    return {
      current,
      roles: [] as RoleRow[],
      permissions: [] as PermissionRow[],
      members: [] as MemberRow[],
      positions: [] as PositionRow[],
      workflowFields: [] as WorkflowFieldPermissionRow[],
      schemaReady: false,
      schemaMissing: schema.missing,
    };
  }
  const [roles, permissions, members, positions, workflowFields] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id,r.code,r.name,r.description,r.is_system,r.status,
              GROUP_CONCAT(DISTINCT rp.permission_code) permissions,
              COUNT(DISTINCT mr.membership_id) member_count
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id=r.id
       LEFT JOIN membership_roles mr ON mr.role_id=r.id
       WHERE r.organization_id=?
       GROUP BY r.id
       ORDER BY r.status='active' DESC,r.is_system DESC,r.name`,
    ).bind(current.organizationId).all<RoleRow>(),
    env.DB.prepare(
      "SELECT code,module,name,description FROM permissions ORDER BY module,code",
    ).all<PermissionRow>(),
    env.DB.prepare(
      `SELECT m.id membership_id,u.display_name,u.email,p.name position_name,
        (SELECT GROUP_CONCAT(DISTINCT r.code)
           FROM membership_roles mr JOIN roles r ON r.id=mr.role_id
          WHERE mr.membership_id=m.id) role_codes,
        (SELECT GROUP_CONCAT(DISTINCT r.name)
           FROM membership_roles mr JOIN roles r ON r.id=mr.role_id
          WHERE mr.membership_id=m.id) role_names,
        (SELECT GROUP_CONCAT(DISTINCT rp.permission_code)
           FROM membership_roles mr
           JOIN roles r ON r.id=mr.role_id AND r.status='active'
           JOIN role_permissions rp ON rp.role_id=r.id
          WHERE mr.membership_id=m.id) inherited_permissions,
        (SELECT GROUP_CONCAT(mpo.permission_code||':'||mpo.effect)
           FROM membership_permission_overrides mpo
          WHERE mpo.membership_id=m.id) override_entries
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
       WHERE m.organization_id=? AND m.status='active' AND u.status='active'
       ORDER BY p.sort_order,u.display_name`,
    ).bind(current.organizationId).all<MemberRow>(),
    env.DB.prepare(
      `SELECT position.code,position.name,department.name department_name
       FROM positions position
       JOIN departments department
         ON department.organization_id=position.organization_id
        AND department.code=position.department_code
       WHERE position.organization_id=? AND position.status='active'
       ORDER BY department.sort_order,position.sort_order,position.name`,
    ).bind(current.organizationId).all<PositionRow>(),
    env.DB.prepare(
      `SELECT field.id,workflow.id workflow_id,workflow.name workflow_name,
              workflow.version_number,step.step_key,step.name step_name,
              COALESCE(field.module_code,'consignment') module_code,
              COALESCE(module.display_name,field.module_code,'委托资料') module_name,
              field.field_key,field.label field_label,field.handler_position_codes
       FROM workflow_step_fields field
       JOIN workflow_definitions workflow ON workflow.id=field.workflow_id
       JOIN workflow_steps step ON step.id=field.step_id
       LEFT JOIN workflow_step_modules module
         ON module.workflow_id=field.workflow_id
        AND module.step_id=field.step_id
        AND module.module_code=COALESCE(field.module_code,'consignment')
       WHERE workflow.organization_id=?
         AND workflow.lifecycle_status!='retired'
         AND workflow.status='active'
         AND step.is_active=1
         AND field.is_active=1
       ORDER BY workflow.name,workflow.version_number DESC,step.sort_order,
                COALESCE(module.sort_order,9999),field.sort_order,field.label`,
    ).bind(current.organizationId).all<WorkflowFieldPermissionRow>(),
  ]);
  return {
    current,
    roles: roles.results,
    permissions: permissions.results,
    members: members.results,
    positions: positions.results,
    workflowFields: workflowFields.results,
    schemaReady: true,
    schemaMissing: [] as string[],
  };
}

async function validatePermissionSelection(selected: string[]) {
  const knownCodes = new Set<string>();
  for (const permissionChunk of chunkD1Values(selected)) {
    const known = await env.DB.prepare(
      `SELECT code FROM permissions WHERE code IN (${d1Placeholders(permissionChunk.length)})`,
    ).bind(...permissionChunk).all<{ code: string }>();
    for (const permission of known.results) knownCodes.add(permission.code);
  }
  return knownCodes.size === selected.length;
}

function selectedPermissionCodes(form: FormData) {
  return [...new Set(form.getAll("permissions").filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  ))];
}

function rolePermissionStatements(roleId: string, selected: string[]) {
  return chunkD1Rows(selected, 2).map((permissionChunk) => env.DB.prepare(
    `INSERT INTO role_permissions(role_id,permission_code) VALUES ${permissionChunk.map(() => "(?,?)").join(",")}`,
  ).bind(...permissionChunk.flatMap((permission) => [roleId, permission])));
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request);
  if (!canManageAccessConfiguration(current)) {
    throw new Response("无权管理账号资格", { status: 403 });
  }
  const schema = await inspectAccessControlSchema(env.DB);
  if (!schema.ready) return { formError: `权限数据库升级尚未完成：${schema.missing.join("、")}。请完成迁移后重试。` };
  const form = await request.formData();
  const intent = valueOf(form, "intent") || "create_role";
  const now = new Date().toISOString();

  if (intent === "update_account_overrides") {
    const membershipId = valueOf(form, "membershipId");
    const member = await env.DB.prepare(
      `SELECT m.id,GROUP_CONCAT(DISTINCT r.code) role_codes
       FROM memberships m
       LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id
       WHERE m.id=? AND m.organization_id=? AND m.status='active'
       GROUP BY m.id`,
    ).bind(membershipId, current.organizationId).first<{ id: string; role_codes: string | null }>();
    if (!member) return { formError: "账号不存在或已经停用", targetId: membershipId };
    const memberRoleCodes = (member.role_codes ?? "").split(",").filter(Boolean);
    if (isProtectedAccessRole(memberRoleCodes)) {
      return { formError: "老板/所有者账户的权限不可抽走或覆盖", targetId: membershipId };
    }

    const overrides: PermissionOverride[] = [];
    for (const [key, rawValue] of form.entries()) {
      if (typeof rawValue !== "string" || !["allow", "deny"].includes(rawValue)) continue;
      if (key.startsWith("override:")) {
        overrides.push({ code: key.slice("override:".length), effect: rawValue as "allow" | "deny" });
      }
    }
    if (!await validatePermissionSelection(overrides.map((item) => item.code))) {
      return { formError: "账户权限积木中包含无效选项", targetId: membershipId };
    }
    const insertStatements = chunkD1Rows(overrides, 6).map((overrideChunk) => env.DB.prepare(
      `INSERT INTO membership_permission_overrides(
        membership_id,permission_code,effect,updated_by_user_id,created_at,updated_at
      ) VALUES ${overrideChunk.map(() => "(?,?,?,?,?,?)").join(",")}`,
    ).bind(...overrideChunk.flatMap((override) => [
      membershipId, override.code, override.effect, current.userId, now, now,
    ])));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM membership_permission_overrides WHERE membership_id=?").bind(membershipId),
      ...insertStatements,
    ]);
    await writeAudit({
      request,
      action: "membership.permissions.override",
      resourceType: "membership",
      resourceId: membershipId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { overrides },
    });
    return { success: "账户安全权限已一次性应用", targetId: membershipId };
  }

  if (intent === "update_position_workflow_fields") {
    const positionCode = valueOf(form, "positionCode");
    const position = await env.DB.prepare(
      `SELECT code,name FROM positions
       WHERE organization_id=? AND code=? AND status='active'`,
    ).bind(current.organizationId, positionCode).first<{ code: string; name: string }>();
    if (!position) return { formError: "岗位不存在或已停用", targetId: positionCode };

    const selectedIds = new Set(form.getAll("workflowFields").filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ));
    const fields = await env.DB.prepare(
      `SELECT field.id,field.workflow_id,field.field_key,field.label,
              field.is_active,field.handler_position_codes,
              step.step_key,COALESCE(field.module_code,'consignment') module_code
       FROM workflow_step_fields field
       JOIN workflow_definitions workflow ON workflow.id=field.workflow_id
       JOIN workflow_steps step ON step.id=field.step_id
       WHERE workflow.organization_id=?
         AND workflow.lifecycle_status!='retired'
         AND workflow.status='active' AND step.is_active=1 AND field.is_active=1`,
    ).bind(current.organizationId).all<{
      id: string;
      workflow_id: string;
      field_key: string;
      label: string;
      is_active: number;
      handler_position_codes: string | null;
      step_key: string;
      module_code: OrderModuleCode;
    }>();
    const knownIds = new Set(fields.results.map((field) => field.id));
    if ([...selectedIds].some((id) => !knownIds.has(id))) {
      return { formError: "字段列表已经变化，请刷新后重试", targetId: positionCode };
    }

    const changes = fields.results.flatMap((field) => {
      const nextCodes = toggleWorkflowFieldHandlerPosition(
        field.handler_position_codes,
        positionCode,
        selectedIds.has(field.id),
      );
      const previous = serializeWorkflowFieldHandlerPositionCodes(
        normalizeWorkflowFieldHandlerPositionCodes(field.handler_position_codes),
      );
      const next = serializeWorkflowFieldHandlerPositionCodes(nextCodes);
      return previous === next ? [] : [{ field, next }];
    });
    const invalid = changes.find(({ field, next }) => field.is_active && !next);
    if (invalid) {
      return {
        formError: `字段“${invalid.field.label}”至少要保留一个填写岗位`,
        targetId: positionCode,
      };
    }
    if (changes.length) {
      await env.DB.batch(changes.map(({ field, next }) => env.DB.prepare(
        "UPDATE workflow_step_fields SET handler_position_codes=?,updated_at=? WHERE id=?",
      ).bind(next, now, field.id)));
      for (const { field, next } of changes) {
        await synchronizeWorkflowFieldHandlerPositionsForInstances({
          workflowId: field.workflow_id,
          stepKey: field.step_key,
          fieldKey: field.field_key,
          moduleCode: field.module_code,
          handlerPositionCodes: next,
        });
      }
    }
    await writeAudit({
      request,
      action: "position.workflow_fields.update",
      resourceType: "position",
      resourceId: position.code,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { changedFieldCount: changes.length },
    });
    return {
      success: `${position.name}的订单工作流字段权限已更新`,
      targetId: position.code,
    };
  }

  const selected = selectedPermissionCodes(form);
  if (!await validatePermissionSelection(selected)) {
    return { formError: "权限选项无效" };
  }

  if (intent === "update_role") {
    const roleId = valueOf(form, "roleId");
    const role = await env.DB.prepare(
      "SELECT id,code,name,status FROM roles WHERE id=? AND organization_id=?",
    ).bind(roleId, current.organizationId).first<{
      id: string;
      code: string;
      name: string;
      status: string;
    }>();
    if (!role) return { formError: "角色不存在", targetId: roleId };
    if (["owner", "boss"].includes(role.code)) {
      return { formError: "老板/所有者角色为系统保护角色，权限不可修改", targetId: roleId };
    }
    if (role.status !== "active") {
      return { formError: "历史停用角色仅供审计查看，不能再修改或分配", targetId: roleId };
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM role_permissions WHERE role_id=?").bind(roleId),
      ...rolePermissionStatements(roleId, selected),
    ]);
    await writeAudit({
      request,
      action: "role.permissions.update",
      resourceType: "role",
      resourceId: roleId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { permissions: selected },
    });
    return { success: `${role.name}的权限积木已更新`, targetId: roleId };
  }

  const name = valueOf(form, "name");
  const code = valueOf(form, "code").toLowerCase();
  const description = valueOf(form, "description");
  const errors: Record<string, string> = {};
  if (name.length < 2 || name.length > 50) errors.name = "角色名称需要 2-50 个字符";
  const codeError = validateCode(code);
  if (codeError) errors.code = codeError;
  if (Object.keys(errors).length) return { errors, values: { name, code, description, permissions: selected } };
  const exists = await env.DB.prepare(
    "SELECT id FROM roles WHERE organization_id=? AND code=?",
  ).bind(current.organizationId, code).first();
  if (exists) return { formError: "角色代码已经存在", values: { name, code, description, permissions: selected } };
  const roleId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO roles(id,organization_id,code,name,description,status,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?)`,
    ).bind(roleId, current.organizationId, code, name, description || null, now, now),
    ...rolePermissionStatements(roleId, selected),
  ]);
  await writeAudit({
    request,
    action: "role.create",
    resourceType: "role",
    resourceId: roleId,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: { code, permissions: selected },
  });
  return { success: "角色已创建", targetId: roleId };
}

export function meta() { return [{ title: "角色权限 | International TMS" }]; }

export default function Roles({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  if (!loaderData.schemaReady) return <>
    <header className="page-header"><div><p className="eyebrow">ACCESS CONTROL MAINTENANCE</p><h1>角色权限暂时只读</h1><p>系统检测到数据库版本落后于当前程序，已停止权限写入以保护现有账号。</p></div></header>
    <section className="panel"><div className="alert warning" role="status">待升级项目：{loaderData.schemaMissing.join("、")}。请重新启动服务；启动命令会自动应用数据库迁移。</div></section>
  </>;
  const grouped = loaderData.permissions.reduce<Record<string, PermissionRow[]>>((groups, permission) => {
    (groups[permission.module] ??= []).push(permission);
    return groups;
  }, {});
  const canManage = canManageAccessConfiguration(loaderData.current);
  const success = actionData && "success" in actionData ? actionData.success : undefined;
  const formError = actionData && "formError" in actionData ? actionData.formError : undefined;
  const values = actionData && "values" in actionData ? actionData.values : undefined;
  const errors = actionData && "errors" in actionData ? actionData.errors : undefined;

  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">MODULAR ACCESS CONTROL</p>
        <h1>角色权限</h1>
        <p>岗位角色提供默认权限，账户权限积木可额外允许或明确拒绝；拒绝优先于角色继承。</p>
      </div>
      {canManage && <Modal title="创建角色" triggerLabel="新增角色" closeSignal={success} size="wide">
        <Form method="post" className="form-grid compact permission-editor-form">
          <input type="hidden" name="intent" value="create_role" />
          <label className="field"><span>角色名称</span><input name="name" required defaultValue={values?.name}/>{errors?.name && <small className="field-error">{errors.name}</small>}</label>
          <label className="field"><span>角色代码</span><input name="code" required placeholder="custom_role" defaultValue={values?.code}/>{errors?.code && <small className="field-error">{errors.code}</small>}</label>
          <label className="field span-2"><span>说明</span><textarea name="description" rows={2} defaultValue={values?.description}/></label>
          <PermissionCheckboxes grouped={grouped} selected={new Set(values?.permissions ?? [])}/>
          <div className="permission-editor-actions span-2"><span>允许创建零权限角色，用于纯岗位或薪资归类。</span><button className="primary" disabled={busy}>创建角色</button></div>
        </Form>
      </Modal>}
    </header>

    <ActionToast message={formError ?? success} tone={formError ? "error" : "success"} data={actionData}/>

    <section className="permission-section">
      <div className="section-heading"><div><h2>岗位角色权限</h2><p>点击角色查看权限来源；启用角色可一次性调整整组权限。</p></div><span>{loaderData.roles.filter((role) => role.status === "active").length} 个启用</span></div>
      <div className="cards role-permission-cards">{loaderData.roles.map((role) => {
        const selected = new Set((role.permissions ?? "").split(",").filter(Boolean));
        const protectedRole = ["owner", "boss"].includes(role.code);
        return <article className={`role-card ${role.status === "disabled" ? "is-disabled" : ""}`} key={role.id}>
          <div><span className={`status-pill ${role.status === "disabled" ? "off" : ""}`}>{role.status === "disabled" ? "历史停用" : role.is_system ? "系统角色" : "自定义角色"}</span><h3>{role.name}</h3><code>{role.code}</code><p>{role.description || "暂无说明"}</p></div>
          <footer><span>{selected.size} 项权限</span><span>{role.member_count} 位成员</span></footer>
          <Modal title={`角色权限 · ${role.name}`} triggerLabel="查看与编辑" triggerClassName="btn small" closeSignal={actionData?.targetId === role.id && success} size="xwide">
            <Form method="post" className="permission-editor-form">
              <input type="hidden" name="intent" value="update_role" />
              <input type="hidden" name="roleId" value={role.id} />
              <div className={`permission-editor-notice ${protectedRole ? "warning" : ""}`}>
                <b>{protectedRole ? "系统保护角色" : role.status === "disabled" ? "历史角色" : "修改岗位默认权限"}</b>
                <span>{protectedRole ? "老板/所有者始终拥有全部权限，不能抽走。" : role.status === "disabled" ? "仅保留历史审计，不允许新分配或修改。" : "保存后使用该角色的账号立即继承新权限；账户级拒绝仍然优先。"}</span>
              </div>
              <PermissionCheckboxes grouped={grouped} selected={selected} disabled={!canManage || protectedRole || role.status === "disabled"}/>
              {canManage && !protectedRole && role.status === "active" && <div className="permission-editor-actions"><span>所有勾选将一次性替换当前角色权限。</span><button className="primary" disabled={busy}>确认应用</button></div>}
            </Form>
          </Modal>
        </article>;
      })}</div>
    </section>

    <section className="permission-section position-workflow-field-section">
      <div className="section-heading">
        <div>
          <h2>订单工作流字段权限</h2>
          <p>按岗位配置可填写字段；这里不指定具体经办账号，订单仍由创建业务员或操作主管分配的负责人办理。</p>
        </div>
        <span>{loaderData.positions.length} 个有效岗位</span>
      </div>
      <div className="cards position-workflow-field-cards">
        {loaderData.positions.map((position) => {
          const selected = new Set(loaderData.workflowFields.filter((field) =>
            normalizeWorkflowFieldHandlerPositionCodes(field.handler_position_codes)
              .includes(position.code),
          ).map((field) => field.id));
          return <article className="role-card position-workflow-field-card" key={position.code}>
            <div>
              <span className="status-pill">{position.department_name}</span>
              <h3>{position.name}</h3>
              <code>{position.code}</code>
              <p>{selected.size} 个订单工作流字段可填写</p>
            </div>
            <footer>
              <span>岗位级权限</span>
              <Modal
                title={`订单字段权限 · ${position.name}`}
                triggerLabel="配置字段"
                triggerClassName="btn small"
                closeSignal={actionData?.targetId === position.code && success}
                size="xwide"
              >
                <PositionWorkflowFieldEditor
                  position={position}
                  fields={loaderData.workflowFields}
                  selected={selected}
                  disabled={!canManage}
                  busy={busy}
                />
              </Modal>
            </footer>
          </article>;
        })}
      </div>
    </section>

    <section className="permission-section account-permission-section">
      <div className="section-heading"><div><h2>账户权限积木</h2><p>在岗位角色之上为某个账号加权限或抽走权限，不改变同岗位其他人。</p></div><span>{loaderData.members.length} 个有效账号</span></div>
      <div className="table-wrap"><table className="account-permission-table">
        <thead><tr><th>账号</th><th>部门 / 岗位</th><th>继承角色</th><th>权限结果</th><th>操作</th></tr></thead>
        <tbody>{loaderData.members.map((member) => {
          const inherited = (member.inherited_permissions ?? "").split(",").filter(Boolean);
          const overrides = parseOverrides(member.override_entries);
          const roleCodes = (member.role_codes ?? "").split(",").filter(Boolean);
          const protectedAccount = isProtectedAccessRole(roleCodes);
          const effective = effectivePermissionCodes({
            inherited,
            overrides,
            allPermissions: loaderData.permissions.map((permission) => permission.code),
            protectedRole: protectedAccount,
          });
          const added = overrides.filter((item) => item.effect === "allow").length;
          const denied = overrides.filter((item) => item.effect === "deny").length;
          const overrideByCode = new Map(overrides.map((item) => [item.code, item.effect]));
          return <tr key={member.membership_id}>
            <td><strong>{member.display_name}</strong><small>{member.email}</small></td>
            <td>{member.position_name || "未绑定岗位"}</td>
            <td>{member.role_names || "未分配角色"}</td>
            <td><strong>{effective.length} 项有效</strong><small>{protectedAccount ? "系统保护" : `安全权限积木 ${added + denied}`}</small></td>
            <td><Modal title={`账户权限 · ${member.display_name}`} triggerLabel="配置积木" triggerClassName="btn small" closeSignal={actionData?.targetId === member.membership_id && success} size="xwide">
              <Form method="post" className="permission-editor-form">
                <input type="hidden" name="intent" value="update_account_overrides" />
                <input type="hidden" name="membershipId" value={member.membership_id} />
                <div className={`permission-editor-notice ${protectedAccount ? "warning" : ""}`}>
                  <b>{member.display_name} · {member.position_name || "未绑定岗位"}</b>
                  <span>{protectedAccount ? "老板/所有者账户不可覆盖，始终拥有全部权限。" : "继承保持岗位默认；允许增加权限；拒绝会覆盖所有角色授权。"}</span>
                </div>
                <div className="account-override-grid">{Object.entries(grouped).map(([module, items]) => <section key={module}>
                  <h3>{moduleLabels[module] ?? module}</h3>
                  {items.map((permission) => {
                    const isInherited = inherited.includes(permission.code);
                    return <label className="account-override-row" key={permission.code}>
                      <span><b>{permission.name}</b><small>{permission.description} · {isInherited ? "角色已授予" : "角色未授予"}</small></span>
                      <select name={`override:${permission.code}`} defaultValue={overrideByCode.get(permission.code) ?? "inherit"} disabled={!canManage || protectedAccount} aria-label={`${permission.name}账户权限`}>
                        <option value="inherit">继承角色</option>
                        <option value="allow">额外允许</option>
                        <option value="deny">明确拒绝</option>
                      </select>
                    </label>;
                  })}
                </section>)}</div>
                {canManage && !protectedAccount && <div className="permission-editor-actions"><span>确认后所有账户级改变一次性生效并写入审计。</span><button className="primary" disabled={busy}>确认应用</button></div>}
              </Form>
            </Modal></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>
  </>;
}

function PositionWorkflowFieldEditor({
  position,
  fields,
  selected,
  disabled,
  busy,
}: {
  position: PositionRow;
  fields: WorkflowFieldPermissionRow[];
  selected: Set<string>;
  disabled: boolean;
  busy: boolean;
}) {
  const groups = fields.reduce<Map<string, WorkflowFieldPermissionRow[]>>((result, field) => {
    const key = `${field.workflow_id}:${field.step_key}`;
    const current = result.get(key) ?? [];
    current.push(field);
    result.set(key, current);
    return result;
  }, new Map());
  return <Form method="post" className="permission-editor-form position-workflow-field-editor">
    <input type="hidden" name="intent" value="update_position_workflow_fields" />
    <input type="hidden" name="positionCode" value={position.code} />
    <div className="permission-editor-notice">
      <b>{position.name} · 岗位字段办理范围</b>
      <span>勾选只决定该岗位能填写哪些字段；具体由谁办理仍取决于订单创建人与操作主管的任务分配。</span>
    </div>
    <div className="position-workflow-field-grid">
      {[...groups.entries()].map(([key, items]) => <section key={key}>
        <h3>{items[0].workflow_name} v{items[0].version_number} · {items[0].step_name}</h3>
        {items.map((field) => <label className="position-workflow-field-row" key={field.id}>
          <input
            type="checkbox"
            name="workflowFields"
            value={field.id}
            defaultChecked={selected.has(field.id)}
            disabled={disabled}
          />
          <span>
            <b>{field.field_label}</b>
            <small>{field.module_name} · {field.field_key}</small>
          </span>
        </label>)}
      </section>)}
    </div>
    {!disabled && <div className="permission-editor-actions">
      <span>保存后，当前开放节点与未来节点立即采用新岗位规则；已完成节点保持不变。</span>
      <button className="primary" disabled={busy}>保存岗位字段权限</button>
    </div>}
  </Form>;
}

function PermissionCheckboxes({
  grouped,
  selected,
  disabled = false,
}: {
  grouped: Record<string, PermissionRow[]>;
  selected: Set<string>;
  disabled?: boolean;
}) {
  return <fieldset className="permission-grid">
    <legend>权限积木</legend>
    {Object.entries(grouped).map(([module, items]) => <div key={module}>
      <strong>{moduleLabels[module] ?? module}</strong>
      {items.map((permission) => <label key={permission.code}>
        <input type="checkbox" name="permissions" value={permission.code} defaultChecked={selected.has(permission.code)} disabled={disabled}/>
        <span><b>{permission.name}</b><small>{permission.description}</small></span>
      </label>)}
    </div>)}
  </fieldset>;
}

function parseOverrides(value: string | null): PermissionOverride[] {
  if (!value) return [];
  return value.split(",").flatMap((entry) => {
    const separator = entry.lastIndexOf(":");
    if (separator < 1) return [];
    const code = entry.slice(0, separator);
    const effect = entry.slice(separator + 1);
    return effect === "allow" || effect === "deny" ? [{ code, effect }] : [];
  });
}
