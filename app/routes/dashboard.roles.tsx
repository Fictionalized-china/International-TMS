import { env } from "cloudflare:workers";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import type { Route } from "./+types/dashboard.roles";
import { requireSessionUser } from "../lib/auth.server";
import { validateCode, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { ActionToast } from "../components/ActionToast";
import { OrganizationAccessTabs } from "../components/OrganizationAccessTabs";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { inspectAccessControlSchema } from "../lib/access-control-schema.server";
import { canManageAccessConfiguration } from "../lib/access-configuration-authority";
import {
  normalizeWorkflowFieldHandlerPositionCodes,
  serializeWorkflowFieldHandlerPositionCodes,
  toggleWorkflowFieldHandlerPosition,
} from "../lib/workflow-field-position-access";
import { synchronizeWorkflowFieldHandlerPositionsForInstances } from "../lib/workflow-fields.server";
import type { OrderModuleCode } from "../lib/order-modules";
import { adminNavigationPermissionGroups } from "../lib/admin-navigation";
import { roleCodeForPosition } from "../lib/position-role";
import { diagnosePositionPermission } from "../lib/position-permission-diagnostics";

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
  position_code: string | null;
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
        p.code position_code,
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
    return {
      formError: "账号级权限覆盖已停用；请在“岗位默认权限”或“工作流字段”中按岗位修改。",
      targetId: valueOf(form, "membershipId"),
    };
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

export function meta() { return [{ title: "权限配置 | International TMS" }]; }

export default function Roles({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [searchParams] = useSearchParams();
  const [roleQuery, setRoleQuery] = useState("");
  const [rolePage, setRolePage] = useState(1);
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [workflowPage, setWorkflowPage] = useState(1);
  const accessView = ["workflow", "diagnostics"].includes(searchParams.get("view") ?? "")
    ? searchParams.get("view")!
    : "positions";
  if (!loaderData.schemaReady) return <>
    <header className="page-header"><div><p className="eyebrow">ACCESS CONTROL MAINTENANCE</p><h1>岗位权限暂时只读</h1><p>系统检测到数据库版本落后于当前程序，已停止权限写入以保护现有账号。</p></div></header>
    <OrganizationAccessTabs permissions={loaderData.current.permissions}/>
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
  const pageSize = 10;
  const normalizedRoleQuery = roleQuery.trim().toLocaleLowerCase("zh-CN");
  const filteredRoles = loaderData.roles.filter((role) => !normalizedRoleQuery ||
    [role.name, role.description ?? ""].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedRoleQuery)));
  const rolePageCount = Math.max(1, Math.ceil(filteredRoles.length / pageSize));
  const currentRolePage = Math.min(rolePage, rolePageCount);
  const pagedRoles = filteredRoles.slice((currentRolePage - 1) * pageSize, currentRolePage * pageSize);
  const normalizedWorkflowQuery = workflowQuery.trim().toLocaleLowerCase("zh-CN");
  const filteredPositions = loaderData.positions.filter((position) => !normalizedWorkflowQuery ||
    [position.name, position.department_name].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedWorkflowQuery)));
  const workflowPageCount = Math.max(1, Math.ceil(filteredPositions.length / pageSize));
  const currentWorkflowPage = Math.min(workflowPage, workflowPageCount);
  const pagedPositions = filteredPositions.slice((currentWorkflowPage - 1) * pageSize, currentWorkflowPage * pageSize);

  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">MODULAR ACCESS CONTROL</p>
        <h1>权限配置</h1>
        <p>只配置岗位能看什么、能做什么、能填写什么；人员账号不在这里单独授权。</p>
      </div>
      {canManage && <Modal title="新增权限模板" triggerLabel="新增权限模板" closeSignal={success} size="wide">
        <Form method="post" className="form-grid compact permission-editor-form">
          <input type="hidden" name="intent" value="create_role" />
          <label className="field"><span>模板名称</span><input name="name" required defaultValue={values?.name}/>{errors?.name && <small className="field-error">{errors.name}</small>}</label>
          <label className="field"><span>模板代码</span><input name="code" required placeholder="custom_role" defaultValue={values?.code}/>{errors?.code && <small className="field-error">{errors.code}</small>}</label>
          <label className="field span-2"><span>说明</span><textarea name="description" rows={2} defaultValue={values?.description}/></label>
          <PermissionCheckboxes grouped={grouped} selected={new Set(values?.permissions ?? [])}/>
          <div className="permission-editor-actions span-2"><span>模板保存后可作为岗位的菜单与操作权限来源。</span><button className="primary" disabled={busy}>创建模板</button></div>
        </Form>
      </Modal>}
    </header>

    <OrganizationAccessTabs permissions={loaderData.current.permissions}/>

    <ActionToast message={formError ?? success} tone={formError ? "error" : "success"} data={actionData}/>

    <nav className="peer-page-tabs access-permission-view-tabs" aria-label="权限配置分类">
      <Link className={accessView === "positions" ? "active" : ""} to="/admin/roles">基础权限</Link>
      <Link className={accessView === "workflow" ? "active" : ""} to="/admin/roles?view=workflow">工作流字段</Link>
      <Link className={accessView === "diagnostics" ? "active" : ""} to="/admin/roles?view=diagnostics">一致性检查</Link>
    </nav>

    {accessView === "positions" && <section className="permission-section">
      <div className="section-heading"><div><h2>岗位基础权限</h2><p>清单只显示权限结果；具体菜单和操作项在弹窗中配置。</p></div><span>{loaderData.roles.filter((role) => role.status === "active").length} 个启用</span></div>
      <div className="permission-ledger-toolbar">
        <label className="field"><span>查找岗位</span><input value={roleQuery} onChange={(event) => { setRoleQuery(event.currentTarget.value); setRolePage(1); }} placeholder="输入岗位或说明" /></label>
        <span>共 {filteredRoles.length} 个岗位</span>
      </div>
      <div className="table-wrap"><table className="permission-ledger-table">
        <thead><tr><th>岗位</th><th>权限范围</th><th>使用情况</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{pagedRoles.map((role) => {
        const selected = new Set((role.permissions ?? "").split(",").filter(Boolean));
        const protectedRole = ["owner", "boss"].includes(role.code);
        return <tr className={role.status === "disabled" ? "is-disabled" : ""} key={role.id}>
          <td><strong>{role.name}</strong><small>{role.description || "暂无说明"}</small></td>
          <td><strong>{protectedRole ? "全部系统权限" : `${selected.size} 项菜单与操作权限`}</strong><small>{role.is_system ? "系统预置模板" : "自定义权限模板"}</small></td>
          <td><strong>{role.member_count} 位成员</strong><small>同岗位账号自动继承</small></td>
          <td><span className={`status-pill ${role.status === "disabled" ? "off" : ""}`}>{role.status === "disabled" ? "已停用" : "启用"}</span></td>
          <td><Modal title={`基础权限 · ${role.name}`} triggerLabel="查看与配置" triggerClassName="btn small" closeSignal={actionData?.targetId === role.id && success} size="xwide">
            <Form method="post" className="permission-editor-form">
              <input type="hidden" name="intent" value="update_role" />
              <input type="hidden" name="roleId" value={role.id} />
              <div className={`permission-editor-notice ${protectedRole ? "warning" : ""}`}>
                <b>{protectedRole ? "系统保护角色" : role.status === "disabled" ? "历史角色" : "修改岗位默认权限"}</b>
                <span>{protectedRole ? "老板/所有者始终拥有全部权限，不能抽走。" : role.status === "disabled" ? "仅保留历史审计，不允许新分配或修改。" : "保存后该岗位的所有在职账号立即采用新权限。"}</span>
              </div>
              <PermissionCheckboxes grouped={grouped} selected={selected} disabled={!canManage || protectedRole || role.status === "disabled"}/>
              {canManage && !protectedRole && role.status === "active" && <div className="permission-editor-actions"><span>所有勾选将一次性替换当前角色权限。</span><button className="primary" disabled={busy}>确认应用</button></div>}
            </Form>
          </Modal></td>
        </tr>;
      })}</tbody>
      </table></div>
      <ClientListPagination page={currentRolePage} pageCount={rolePageCount} total={filteredRoles.length} unit="个岗位" onChange={setRolePage} />
    </section>}

    {accessView === "workflow" && <section className="permission-section position-workflow-field-section">
      <div className="section-heading">
        <div>
          <h2>工作流字段办理权限</h2>
          <p>决定每个岗位能填写哪些订单字段；具体经办人仍由创建人与任务分配关系确定。</p>
        </div>
        <span>{loaderData.positions.length} 个有效岗位</span>
      </div>
      <div className="permission-ledger-toolbar">
        <label className="field"><span>查找岗位</span><input value={workflowQuery} onChange={(event) => { setWorkflowQuery(event.currentTarget.value); setWorkflowPage(1); }} placeholder="输入岗位或部门" /></label>
        <span>共 {filteredPositions.length} 个岗位</span>
      </div>
      <div className="table-wrap"><table className="permission-ledger-table">
        <thead><tr><th>岗位</th><th>归属部门</th><th>可填写字段</th><th>权限层级</th><th>操作</th></tr></thead>
        <tbody>{pagedPositions.map((position) => {
          const selected = new Set(loaderData.workflowFields.filter((field) =>
            normalizeWorkflowFieldHandlerPositionCodes(field.handler_position_codes)
              .includes(position.code),
          ).map((field) => field.id));
          return <tr key={position.code}>
            <td><strong>{position.name}</strong></td>
            <td>{position.department_name}</td>
            <td><strong>{selected.size} 个字段</strong><small>按当前启用工作流统计</small></td>
            <td><span className="status-pill">岗位级</span></td>
            <td><Modal
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
              </Modal></td>
          </tr>;
        })}</tbody>
      </table></div>
      <ClientListPagination page={currentWorkflowPage} pageCount={workflowPageCount} total={filteredPositions.length} unit="个岗位" onChange={setWorkflowPage} />
    </section>}

    {accessView === "diagnostics" && <section className="permission-section account-permission-section">
      <div className="section-heading"><div><h2>账号与岗位权限一致性</h2><p>只诊断账号的岗位绑定、岗位角色映射和已停用的旧覆盖数据；不提供账号级授权。</p></div><span>{loaderData.members.length} 个有效账号</span></div>
      <div className="table-wrap"><table className="account-permission-table">
        <thead><tr><th>账号</th><th>岗位</th><th>期望岗位角色</th><th>实际映射</th><th>权限结果</th><th>诊断</th></tr></thead>
        <tbody>{loaderData.members.map((member) => {
          const inherited = (member.inherited_permissions ?? "").split(",").filter(Boolean);
          const roleCodes = (member.role_codes ?? "").split(",").filter(Boolean);
          const expectedRoleCode = member.position_code
            ? roleCodeForPosition(member.position_code)
            : null;
          const legacyOverrideCount = (member.override_entries ?? "").split(",").filter(Boolean).length;
          const diagnostic = diagnosePositionPermission({
            positionCode: member.position_code,
            expectedRoleCode,
            actualRoleCodes: roleCodes,
            legacyOverrideCount,
          });
          return <tr key={member.membership_id}>
            <td><strong>{member.display_name}</strong><small>{member.email}</small></td>
            <td>{member.position_name || "未绑定岗位"}</td>
            <td><code>{expectedRoleCode || "—"}</code></td>
            <td><strong>{member.role_names || "未分配角色"}</strong><small>{roleCodes.join("、") || "—"}</small></td>
            <td><strong>{inherited.length} 项岗位权限</strong><small>账号级覆盖不参与运行时鉴权</small></td>
            <td><span className={`status-pill ${diagnostic.status === "conflict" ? "off" : ""}`}>{diagnostic.status === "consistent" ? "一致" : "需迁移"}</span><small>{diagnostic.issues.join("；") || "岗位权限映射正常"}</small></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>}
  </>;
}

function ClientListPagination({
  page,
  pageCount,
  total,
  unit,
  onChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  unit: string;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const pageNumbers = Array.from(new Set([1, page - 1, page, page + 1, pageCount]))
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((left, right) => left - right);
  return <footer className="compact-ledger-pagination" aria-label="列表分页">
    <span>每页 10 {unit} · 第 {page} / {pageCount} 页 · 共 {total} {unit}</span>
    <div>
      <button type="button" className="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
      {pageNumbers.map((pageNumber) => <button
        type="button"
        key={pageNumber}
        className={pageNumber === page ? "active" : "secondary"}
        aria-current={pageNumber === page ? "page" : undefined}
        onClick={() => onChange(pageNumber)}
      >{pageNumber}</button>)}
      <button type="button" className="secondary" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>下一页</button>
    </div>
  </footer>;
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
  const selectedSignature = [...selected].sort().join("\u0000");
  const [selectedCodes, setSelectedCodes] = useState(() => new Set(selected));
  const [expandedModules, setExpandedModules] = useState(() => new Set(
    Object.entries(grouped)
      .filter(([, items]) => items.some((permission) => selected.has(permission.code)))
      .map(([module]) => module),
  ));
  const knownCodes = new Set(
    Object.values(grouped).flat().map((permission) => permission.code),
  );

  useEffect(() => {
    setSelectedCodes(new Set(selected));
    setExpandedModules(new Set(
      Object.entries(grouped)
        .filter(([, items]) => items.some((permission) => selected.has(permission.code)))
        .map(([module]) => module),
    ));
  }, [selectedSignature]);

  function setPermission(code: string, checked: boolean) {
    setSelectedCodes((current) => {
      const next = new Set(current);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  function setNavigationGroup(
    group: (typeof adminNavigationPermissionGroups)[number],
    checked: boolean,
  ) {
    setSelectedCodes((current) => {
      const next = new Set(current);
      const codes = checked
        ? group.enablePermissionCodes
        : group.controllingPermissionCodes;
      codes.filter((code) => knownCodes.has(code)).forEach((code) => {
        if (checked) next.add(code);
        else next.delete(code);
      });
      return next;
    });
  }

  function togglePermissionDirectory(module: string) {
    setExpandedModules((current) => {
      const next = new Set(current);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });
  }

  return <>
    <fieldset className="admin-menu-permission-grid" disabled={disabled}>
      <legend>一级菜单快捷配置</legend>
      <p>批量勾选会同步下方现有权限；路由和接口仍按具体权限校验，可继续在下方精细调整。</p>
      <div className="admin-menu-permission-options">
        {adminNavigationPermissionGroups.map((group) => {
          const enableCodes = group.enablePermissionCodes.filter((code) => knownCodes.has(code));
          const controllingCodes = group.controllingPermissionCodes.filter((code) => knownCodes.has(code));
          const checked = enableCodes.length > 0 && enableCodes.every((code) => selectedCodes.has(code));
          const hasSelected = controllingCodes.some((code) => selectedCodes.has(code));
          return <label key={group.key}>
            <IndeterminateCheckbox
              checked={checked}
              indeterminate={!checked && hasSelected}
              disabled={disabled || enableCodes.length === 0}
              onChange={(event) => setNavigationGroup(group, event.currentTarget.checked)}
            />
            <span><b>{group.label}</b><small>{group.description}</small></span>
          </label>;
        })}
      </div>
    </fieldset>
    <fieldset className="permission-grid permission-directory">
      <legend>具体权限</legend>
      <p className="permission-directory-hint">按业务目录展开后再配置具体权限；目录右侧显示已选数量。</p>
      <div className="permission-directory-list">
        {Object.entries(grouped).map(([module, items]) => {
          const selectedCount = items.filter((permission) => selectedCodes.has(permission.code)).length;
          const expanded = expandedModules.has(module);
          return <section className={`permission-directory-group${expanded ? " is-open" : ""}`} key={module}>
            <button
              type="button"
              className="permission-directory-summary"
              aria-expanded={expanded}
              onClick={() => togglePermissionDirectory(module)}
            >
              <span className="permission-directory-chevron" aria-hidden="true">›</span>
              <span className="permission-directory-title">
                <b>{moduleLabels[module] ?? module}</b>
                <small>{items.length} 项可配置权限</small>
              </span>
              <span className="permission-directory-count">{selectedCount}/{items.length} 已选</span>
            </button>
            <div className="permission-directory-items" hidden={!expanded}>
              {items.map((permission) => <label key={permission.code}>
                <input
                  type="checkbox"
                  name="permissions"
                  value={permission.code}
                  checked={selectedCodes.has(permission.code)}
                  disabled={disabled}
                  onChange={(event) => setPermission(permission.code, event.currentTarget.checked)}
                />
                <span><b>{permission.name}</b><small>{permission.description}</small></span>
              </label>)}
            </div>
          </section>;
        })}
      </div>
    </fieldset>
  </>;
}

function IndeterminateCheckbox({
  indeterminate,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { indeterminate: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return <input
    {...props}
    ref={inputRef}
    type="checkbox"
    aria-checked={indeterminate ? "mixed" : props.checked}
  />;
}
