import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.positions";
import { ConfirmAction } from "../components/ConfirmAction";
import { ActionToast } from "../components/ActionToast";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import {
  isProtectedAccessPosition,
  officialPositionRoleCodes,
  positionRoleCodeSql,
  roleCodeForPosition,
} from "../lib/position-role";
import { inspectAccessControlSchema } from "../lib/access-control-schema.server";
import { OrganizationAccessTabs } from "../components/OrganizationAccessTabs";
import { Modal } from "../components/Modal";

type Position = {
  id: string;
  code: string;
  name: string;
  department_code: string | null;
  department_name: string | null;
  status: string;
  sort_order: number;
  role_code: string;
  permissions: string | null;
  portal_order_scope: string;
  portal_default_filter: string;
  business_data_scope: string;
};

type Department = { code: string; name: string };
type Member = {
  membership_id: string;
  user_id: string;
  display_name: string;
  email: string;
  title: string | null;
  position_id: string | null;
  position_name: string | null;
  department_code: string | null;
  department_name: string | null;
  role_codes: string | null;
};

const MEMBER_PAGE_SIZE = 10;

const dataScopeLabels: Record<string, string> = {
  self: "本人责任数据",
  department: "本部门数据",
  warehouse: "授权仓库数据",
  region: "授权区域数据",
  company: "全公司数据",
};

const defaultFilterLabels: Record<string, string> = {
  open: "默认查看未完成",
  all: "默认查看全部",
  blocked: "默认查看有阻断",
  overdue: "默认查看即将或已经超时",
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "user.view");
  await ensurePositionsSeed(current.organizationId);
  const url = new URL(request.url);
  const view = "positions";
  const q = (url.searchParams.get("q") ?? "").trim();
  const department = url.searchParams.get("department") ?? "";
  const position = url.searchParams.get("position") ?? "";
  const binding = ["bound", "unbound"].includes(url.searchParams.get("binding") ?? "")
    ? url.searchParams.get("binding")!
    : "";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const memberConditions = ["m.organization_id=?", "m.status='active'", "u.status='active'"];
  const memberBindings: unknown[] = [current.organizationId];
  if (q) {
    memberConditions.push("(u.display_name LIKE ? OR u.email LIKE ? OR COALESCE(p.name,'') LIKE ? OR COALESCE(d.name,'') LIKE ?)");
    const term = `%${q}%`;
    memberBindings.push(term, term, term, term);
  }
  if (department) {
    memberConditions.push("p.department_code=?");
    memberBindings.push(department);
  }
  if (position) {
    memberConditions.push("m.position_id=?");
    memberBindings.push(position);
  }
  if (binding === "bound") memberConditions.push("m.position_id IS NOT NULL");
  if (binding === "unbound") memberConditions.push("m.position_id IS NULL");
  const memberWhere = memberConditions.join(" AND ");
  const memberSql = `SELECT m.id membership_id,u.id user_id,u.display_name,u.email,m.title,m.position_id,p.name position_name,
              p.department_code,d.name department_name,${positionRoleCodeSql("p.code")} role_codes
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN positions p ON p.id=m.position_id
       LEFT JOIN departments d ON d.organization_id=m.organization_id AND d.code=p.department_code
       WHERE ${memberWhere}
       ORDER BY u.display_name
       LIMIT ? OFFSET ?`;
  const memberCountSql = `SELECT COUNT(*) total FROM memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN positions p ON p.id=m.position_id
       LEFT JOIN departments d ON d.organization_id=m.organization_id AND d.code=p.department_code
       WHERE ${memberWhere}`;
  const [positions, departments, members, memberCount] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id,p.code,p.name,p.department_code,d.name department_name,p.status,p.sort_order,
              CASE p.code
                WHEN 'BOSS' THEN 'boss'
                WHEN 'DEVELOPER' THEN 'developer'
                WHEN 'DOC' THEN 'pos_doc'
                WHEN 'CS' THEN 'pos_customer_service'
                WHEN 'FINANCE' THEN 'pos_finance'
                WHEN 'SALES' THEN 'pos_sales'
                WHEN 'BUSINESS_SUPERVISOR' THEN 'pos_business_supervisor'
                WHEN 'OPERATION_SUPERVISOR' THEN 'pos_operation_supervisor'
                WHEN 'OVERSEAS' THEN 'pos_overseas'
                WHEN 'CONTAINER' THEN 'pos_container'
                WHEN 'SALES_ASSISTANT' THEN 'pos_sales_assistant'
                WHEN 'OPERATION' THEN 'pos_operation'
                WHEN 'BUSINESS_ROUTE' THEN 'pos_business_route'
                WHEN 'BOOKING' THEN 'pos_booking'
                WHEN 'TRACKING' THEN 'pos_tracking'
                WHEN 'LOADING' THEN 'pos_front_loading'
                WHEN 'FINANCE_ACCOUNTING' THEN 'pos_finance'
                WHEN 'CASHIER' THEN 'pos_cashier'
                WHEN 'HR_ADMIN' THEN 'pos_hr_admin'
                WHEN 'WAREHOUSE' THEN 'warehouse_operator'
                WHEN 'OVERSEAS_WAREHOUSE' THEN 'overseas_warehouse_operator'
                ELSE lower(p.code)
              END role_code,
              (SELECT GROUP_CONCAT(rp.permission_code)
                 FROM roles r
                 LEFT JOIN role_permissions rp ON rp.role_id=r.id
                WHERE r.organization_id=p.organization_id
                  AND r.code=CASE p.code
                    WHEN 'BOSS' THEN 'boss'
                    WHEN 'DEVELOPER' THEN 'developer'
                    WHEN 'DOC' THEN 'pos_doc'
                    WHEN 'CS' THEN 'pos_customer_service'
                    WHEN 'FINANCE' THEN 'pos_finance'
                    WHEN 'SALES' THEN 'pos_sales'
                    WHEN 'BUSINESS_SUPERVISOR' THEN 'pos_business_supervisor'
                    WHEN 'OPERATION_SUPERVISOR' THEN 'pos_operation_supervisor'
                    WHEN 'OVERSEAS' THEN 'pos_overseas'
                    WHEN 'CONTAINER' THEN 'pos_container'
                    WHEN 'SALES_ASSISTANT' THEN 'pos_sales_assistant'
                    WHEN 'OPERATION' THEN 'pos_operation'
                    WHEN 'BUSINESS_ROUTE' THEN 'pos_business_route'
                    WHEN 'BOOKING' THEN 'pos_booking'
                    WHEN 'TRACKING' THEN 'pos_tracking'
                    WHEN 'LOADING' THEN 'pos_front_loading'
                    WHEN 'FINANCE_ACCOUNTING' THEN 'pos_finance'
                    WHEN 'CASHIER' THEN 'pos_cashier'
                    WHEN 'HR_ADMIN' THEN 'pos_hr_admin'
                    WHEN 'WAREHOUSE' THEN 'warehouse_operator'
                    WHEN 'OVERSEAS_WAREHOUSE' THEN 'overseas_warehouse_operator'
                    ELSE lower(p.code)
                  END) permissions,
              COALESCE(pps.order_scope,CASE WHEN p.code IN ('BOSS','DEVELOPER') THEN 'all_orders' ELSE 'current_position' END) portal_order_scope,
              COALESCE(pps.default_filter,'open') portal_default_filter,
              COALESCE(pps.business_data_scope,CASE
                WHEN p.code IN ('BOSS','DEVELOPER') THEN 'company'
                WHEN p.code IN ('BUSINESS_SUPERVISOR','OPERATION_SUPERVISOR') THEN 'department'
                WHEN p.code IN ('WAREHOUSE','OVERSEAS_WAREHOUSE') THEN 'warehouse'
                WHEN p.code='OVERSEAS' THEN 'region'
                ELSE 'self' END) business_data_scope
       FROM positions p
       LEFT JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code
       LEFT JOIN position_portal_settings pps ON pps.organization_id=p.organization_id AND pps.position_id=p.id
       WHERE p.organization_id=?
       ORDER BY p.sort_order,p.name`,
    ).bind(current.organizationId).all<Position>(),
    env.DB.prepare(
      "SELECT code,name FROM departments WHERE organization_id=? AND status='active' ORDER BY sort_order,name",
    ).bind(current.organizationId).all<Department>(),
    env.DB.prepare(memberSql).bind(...memberBindings, MEMBER_PAGE_SIZE, (page - 1) * MEMBER_PAGE_SIZE).all<Member>(),
    env.DB.prepare(memberCountSql).bind(...memberBindings).first<{ total: number }>(),
  ]);
  const memberTotal = Number(memberCount?.total ?? 0);
  return {
    current,
    positions: positions.results,
    departments: departments.results,
    members: members.results,
    view,
    filters: { q, department, position, binding },
    memberPagination: {
      page,
      pageCount: Math.max(1, Math.ceil(memberTotal / MEMBER_PAGE_SIZE)),
      pageSize: MEMBER_PAGE_SIZE,
      total: memberTotal,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "user.manage");
  const schema = await inspectAccessControlSchema(env.DB);
  if (!schema.ready) return { formError: `权限数据库升级尚未完成：${schema.missing.join("、")}。为保护岗位关系，本次修改未执行。` };
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (intent === "assign_member_position") {
    const membershipId = valueOf(form, "membershipId");
    const positionId = valueOf(form, "positionId");
    const position = await env.DB.prepare(
      `SELECT p.id,p.code,p.name,p.department_code,d.id department_id
         FROM positions p
         JOIN departments d
           ON d.organization_id=p.organization_id AND d.code=p.department_code AND d.status='active'
        WHERE p.id=? AND p.organization_id=? AND p.status='active'`,
    ).bind(positionId, current.organizationId).first<{
      id: string;
      code: string;
      name: string;
      department_code: string;
      department_id: string;
    }>();
    const membership = await env.DB.prepare(
      `SELECT m.id,p.code position_code
       FROM memberships m
       LEFT JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
       WHERE m.id=? AND m.organization_id=? AND m.status='active'`,
    ).bind(membershipId, current.organizationId).first<{
      id: string;
      position_code: string | null;
    }>();
    if (!position || !membership) return { formError: "请选择有效账号和岗位" };
    if (isProtectedAccessPosition(membership.position_code)) {
      return { formError: "老板/所有者账户的岗位和角色不可修改" };
    }
    if (isProtectedAccessPosition(position.code) && !isProtectedAccessPosition(current.positionCode)) {
      return { formError: "只有老板/所有者可以分配受保护岗位" };
    }
    const roleCode = roleCodeForPosition(position.code);
    const role = await env.DB.prepare(
      "SELECT id FROM roles WHERE organization_id=? AND code=? AND status='active'",
    ).bind(current.organizationId, roleCode).first<{ id: string }>();
    if (!role) return { formError: `岗位 ${position.name} 还没有对应权限模板，请先执行数据库迁移或在岗位权限中补齐` };
    await env.DB.batch([
      env.DB.prepare("UPDATE memberships SET department_id=?,position_id=?,title=?,updated_at=? WHERE id=? AND organization_id=?").bind(position.department_id, position.id, position.name, now, membershipId, current.organizationId),
      env.DB.prepare("DELETE FROM membership_roles WHERE membership_id=? AND role_id IN (SELECT id FROM roles WHERE organization_id=? AND (code LIKE 'pos_%' OR code IN ('boss','developer','warehouse_operator','overseas_warehouse_operator')))").bind(membershipId, current.organizationId),
      env.DB.prepare("INSERT OR IGNORE INTO membership_roles(membership_id,role_id) VALUES(?,?)").bind(membershipId, role.id),
    ]);
    await writeAudit({
      request,
      action: "position.assign_member",
      resourceType: "membership",
      resourceId: membershipId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: {
        departmentCode: position.department_code,
        positionCode: position.code,
        roleCode,
      },
    });
    return { success: `已把账号绑定到岗位：${position.name}` };
  }

  if (intent === "toggle") {
    const id = valueOf(form, "positionId");
    const next = valueOf(form, "status");
    if (!["active","disabled"].includes(next)) return { formError: "岗位目标状态无效" };
    const row = await env.DB.prepare(
      "SELECT status,code FROM positions WHERE id=? AND organization_id=?",
    ).bind(id, current.organizationId).first<{ status: string; code: string }>();
    if (!row) return { formError: "岗位不存在" };
    if (row.status === next) return { formError: next === "active" ? "岗位已启用" : "岗位已停用" };
    if (next === "disabled") {
      if (isProtectedAccessPosition(row.code)) return { formError: "老板和开发者岗位不可停用" };
      const unresolved = await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM memberships member
            WHERE member.organization_id=? AND member.position_id=? AND member.status='active') active_members,
          (SELECT COUNT(DISTINCT responsibility.order_id) FROM (
            SELECT orders.id order_id FROM transport_orders orders
            JOIN memberships member ON member.user_id IN (orders.current_assignee_user_id,orders.operation_supervisor_user_id)
             AND member.organization_id=orders.organization_id AND member.position_id=? AND member.status='active'
            WHERE orders.organization_id=? AND orders.status NOT IN ('completed','cancelled')
            UNION ALL
            SELECT module.order_id FROM order_module_instances module
            JOIN memberships member ON member.user_id=module.assignee_user_id
             AND member.organization_id=module.organization_id AND member.position_id=? AND member.status='active'
            JOIN transport_orders orders ON orders.id=module.order_id AND orders.organization_id=module.organization_id
            WHERE module.organization_id=? AND orders.status NOT IN ('completed','cancelled')
            UNION ALL
            SELECT task.order_id FROM order_tasks task
            JOIN memberships member ON member.user_id=task.assignee_user_id
             AND member.organization_id=task.organization_id AND member.position_id=? AND member.status='active'
            JOIN transport_orders orders ON orders.id=task.order_id AND orders.organization_id=task.organization_id
            WHERE task.organization_id=? AND task.status!='completed' AND orders.status NOT IN ('completed','cancelled')
          ) responsibility) unresolved_orders`,
      ).bind(
        current.organizationId, id,
        id, current.organizationId,
        id, current.organizationId,
        id, current.organizationId,
      ).first<{ active_members: number; unresolved_orders: number }>();
      if (Number(unresolved?.active_members ?? 0) || Number(unresolved?.unresolved_orders ?? 0)) {
        return {
          formError: `岗位仍有 ${Number(unresolved?.active_members ?? 0)} 名在岗人员、${Number(unresolved?.unresolved_orders ?? 0)} 票未完责任；请先完成转岗和主管重分配`,
        };
      }
    }
    const result = await env.DB.prepare(
      "UPDATE positions SET status=?,updated_at=? WHERE id=? AND organization_id=? AND status=?",
    ).bind(next, now, id, current.organizationId, row.status).run();
    if (!Number(result.meta?.changes || 0)) return { formError: "岗位状态已被其他人修改，请刷新后查看" };
    await writeAudit({
      request,
      action: `position.${next}`,
      resourceType: "position",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
    });
    return { success: "岗位状态已更新" };
  }

  if (intent === "portal_settings") {
    const positionId = valueOf(form, "positionId");
    const defaultFilter = valueOf(form, "defaultFilter");
    const requestedDataScope = valueOf(form, "dataScope");
    const allowedDataScopes = ["self", "department", "warehouse", "region", "company"];
    if (!["open", "all", "blocked", "overdue"].includes(defaultFilter))
      return { formError: "任务工作台配置无效" };
    if (!allowedDataScopes.includes(requestedDataScope)) return { formError: "岗位数据范围无效" };
    const position = await env.DB.prepare("SELECT id,code FROM positions WHERE id=? AND organization_id=?").bind(positionId, current.organizationId).first<{ id: string; code: string }>();
    if (!position) return { formError: "岗位不存在" };
    const dataScope = isProtectedAccessPosition(position.code) ? "company" : requestedDataScope;
    await env.DB.prepare(
      `INSERT INTO position_portal_settings(id,organization_id,position_id,order_scope,default_filter,business_data_scope,updated_by_user_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,position_id) DO UPDATE SET
         order_scope=excluded.order_scope,default_filter=excluded.default_filter,business_data_scope=excluded.business_data_scope,
         updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(), current.organizationId, positionId, "current_position", defaultFilter, dataScope, current.userId, now, now).run();
    return { success: "岗位业务数据范围和任务工作台默认筛选已更新", targetId: positionId };
  }

  const code = valueOf(form, "code").toUpperCase();
  const name = valueOf(form, "name");
  const departmentCode = valueOf(form, "departmentCode") || null;
  const sortOrder = Number(valueOf(form, "sortOrder") || 100);
  if (!/^[A-Z0-9-_]{2,32}$/.test(code) || name.length < 2 || name.length > 40 || !Number.isSafeInteger(sortOrder))
    return { formError: "请填写有效的岗位代码、岗位名称和排序" };
  if (!departmentCode)
    return { formError: "岗位必须归属到具体部门" };
  const department = await env.DB.prepare(
    "SELECT id FROM departments WHERE organization_id=? AND code=? AND status='active'",
  ).bind(current.organizationId, departmentCode).first<{ id: string }>();
  if (!department) return { formError: "请选择有效的归属部门" };
  const roleCode = roleCodeForPosition(code);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,department_code=excluded.department_code,status='active',
         sort_order=excluded.sort_order,updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(), current.organizationId, code, name, departmentCode, sortOrder, now, now),
    env.DB.prepare(
      `INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,'active',?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,description=excluded.description,status='active',updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      current.organizationId,
      roleCode,
      name,
      `${name} position permission profile`,
      officialPositionRoleCodes.includes(roleCode) ? 1 : 0,
      now,
      now,
    ),
  ]);
  const savedPosition = await env.DB.prepare(
    "SELECT id FROM positions WHERE organization_id=? AND code=?",
  ).bind(current.organizationId, code).first<{ id: string }>();
  if (savedPosition) {
    await env.DB.prepare(
      "UPDATE memberships SET department_id=?,title=?,updated_at=? WHERE organization_id=? AND position_id=?",
    ).bind(department.id, name, now, current.organizationId, savedPosition.id).run();
  }
  await writeAudit({
    request,
    action: "position.upsert",
    resourceType: "position",
    resourceId: code,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: { code, name, departmentCode },
  });
  return { success: `岗位 ${name} 已保存` };
}

export default function Positions({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canManage = loaderData.current.permissions.includes("user.manage");
  const success = actionData && "success" in actionData ? actionData.success : undefined;
  const targetId = actionData && "targetId" in actionData ? actionData.targetId : undefined;
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">POSITION ACCESS</p>
          <h1>岗位设置</h1>
          <p>定义岗位及其业务范围；人员归属在“人员账号”，菜单和工作流权限在“权限配置”维护。</p>
        </div>
        <div className="page-header-actions">
          <span className="status-pill">{loaderData.positions.length} 个岗位</span>
          {canManage && <Modal title="新增岗位" triggerLabel="新增岗位" closeSignal={success} size="wide">
            <Form method="post" className="form-grid compact position-editor-form">
              <input type="hidden" name="intent" value="upsert" />
              <label className="field">
                <span>岗位名称 *</span>
                <input name="name" placeholder="例如：订舱岗" required />
              </label>
              <label className="field">
                <span>岗位代码 *</span>
                <input name="code" placeholder="例如：BOOKING" required />
              </label>
              <label className="field">
                <span>归属部门 *</span>
                <select name="departmentCode" required>
                  <option value="">选择归属部门</option>
                  {loaderData.departments.map((department) => (
                    <option key={department.code} value={department.code}>{department.name}</option>
                  ))}
                </select>
              </label>
              <label className="field position-sort-field">
                <span>显示顺序</span>
                <input name="sortOrder" type="number" step="1" defaultValue="100" />
              </label>
              <div className="dialog-form-actions span-2">
                <span>保存后可在“权限配置”中设置该岗位的菜单、操作和工作流字段。</span>
                <button className="primary" disabled={busy}>保存岗位</button>
              </div>
            </Form>
          </Modal>}
        </div>
      </header>
      <OrganizationAccessTabs permissions={loaderData.current.permissions}/>
      <ActionToast data={actionData} />
      <section className="panel position-settings-panel">
        <div className="panel-header">
          <div>
            <h2>岗位列表</h2>
            <p>页面只展示岗位摘要；低频设置进入弹窗，避免在表格中同时堆放大量控件。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="position-settings-table">
            <thead>
              <tr>
                <th>岗位</th>
                <th>归属部门</th>
                <th>权限摘要</th>
                <th>数据范围</th>
                <th>工作台默认</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.positions.map((position) => {
                const permissionCount = (position.permissions || "").split(",").filter(Boolean).length;
                const protectedPosition = isProtectedAccessPosition(position.code);
                return (
                  <tr key={position.id}>
                    <td>
                      <strong>{position.name}</strong>
                      {protectedPosition && <small>系统保护岗位</small>}
                    </td>
                    <td>{position.department_name ?? "未指定部门"}</td>
                    <td>
                      {position.code === "BOSS" ? (
                        <strong>全部权限</strong>
                      ) : permissionCount ? (
                        <strong>{permissionCount} 项菜单与操作权限</strong>
                      ) : (
                        <span className="muted-text">尚未配置</span>
                      )}
                    </td>
                    <td>
                      <strong>{dataScopeLabels[position.business_data_scope] ?? "按岗位授权"}</strong>
                    </td>
                    <td>
                      <span>{defaultFilterLabels[position.portal_default_filter] ?? "默认查看未完成"}</span>
                    </td>
                    <td>
                      <span className={`status-pill ${position.status !== "active" ? "off" : ""}`}>
                        {position.status === "active" ? "启用" : "停用"}
                      </span>
                    </td>
                    <td>
                      <div className="position-settings-actions">
                        <Link className="btn small" to="/admin/roles">配置权限</Link>
                        {canManage && <Modal
                          title={`业务范围 · ${position.name}`}
                          triggerLabel="设置范围"
                          triggerClassName="btn small"
                          closeSignal={targetId === position.id && success}
                          size="wide"
                        >
                          <Form method="post" className="position-scope-dialog">
                            <input type="hidden" name="intent" value="portal_settings" />
                            <input type="hidden" name="positionId" value={position.id} />
                            {protectedPosition && <input type="hidden" name="dataScope" value="company" />}
                            <div className="position-scope-grid">
                              <label className="field">
                                <span>可查看的数据</span>
                                <select name={protectedPosition ? undefined : "dataScope"} defaultValue={position.business_data_scope} disabled={protectedPosition}>
                                  <option value="self">本人责任数据</option>
                                  <option value="department">本部门数据</option>
                                  <option value="warehouse">授权仓库数据</option>
                                  <option value="region">授权区域数据</option>
                                  <option value="company">全公司数据</option>
                                </select>
                              </label>
                              <label className="field">
                                <span>任务工作台默认筛选</span>
                                <select name="defaultFilter" defaultValue={position.portal_default_filter}>
                                  <option value="open">未完成</option>
                                  <option value="all">全部</option>
                                  <option value="blocked">有阻断</option>
                                  <option value="overdue">即将或已经超时</option>
                                </select>
                              </label>
                            </div>
                            <div className="dialog-form-actions">
                              <span>{protectedPosition ? "系统保护岗位固定查看全公司数据。" : "该设置只控制数据范围和默认筛选，不改变具体操作权限。"}</span>
                              <button className="primary" disabled={busy}>保存设置</button>
                            </div>
                          </Form>
                        </Modal>}
                      {canManage && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="positionId" value={position.id} />
                          <input type="hidden" name="status" value={position.status === "active" ? "disabled" : "active"} />
                          {position.status === "active"
                            ? <ConfirmAction title="停用岗位" description={`停用后“${position.name}”不能再分配给人员或承接新的岗位待办；现有成员关系与历史审计保留。`} triggerLabel="停用" confirmLabel="确认停用" pending={busy}/>
                            : <button className="text-button" disabled={busy}>启用</button>}
                        </Form>
                      )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

async function ensurePositionsSeed(organizationId: string) {
  const now = new Date().toISOString();
  const defaults: Array<[string, string, string, number]> = [
    ["BOSS", "老板", "ZJB", 1],
    ["DEVELOPER", "开发者", "ZJB", 2],
    ["SALES", "业务岗", "SALER", 10],
    ["BUSINESS_SUPERVISOR", "业务主管", "SALER", 20],
    ["OPERATION_SUPERVISOR", "操作主管", "OP", 30],
    ["OPERATION", "操作岗（含运踪）", "OP", 40],
    ["DOC", "单证岗", "OP", 50],
    ["CS", "客服岗", "OP", 60],
    ["BUSINESS_ROUTE", "商务报价岗", "BUS", 70],
    ["LOADING", "前端配载岗", "OP", 80],
    ["FINANCE_ACCOUNTING", "财务会计岗", "ACC", 90],
    ["CASHIER", "出纳岗", "ACC", 100],
    ["HR_ADMIN", "人事行政岗", "HR", 110],
    ["WAREHOUSE", "仓库岗", "OP", 120],
    ["OVERSEAS_WAREHOUSE", "境外仓库岗", "OP", 130],
  ];
  await env.DB.batch(defaults.map(([code, name, departmentCode, sort]) =>
    env.DB.prepare(
      `INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,department_code=excluded.department_code,sort_order=excluded.sort_order,updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(), organizationId, code, name, departmentCode, sort, now, now),
  ));
  await env.DB.batch(defaults.map(([code, name]) => {
    const roleCode = roleCodeForPosition(code);
    return env.DB.prepare(
      `INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
       VALUES(?,?,?,?,?,1,'active',?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,description=excluded.description,status='active',updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      roleCode,
      name,
      `${name} position permission profile`,
      now,
      now,
    );
  }));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO position_portal_settings(id,organization_id,position_id,order_scope,default_filter,created_at,updated_at)
     SELECT lower(hex(randomblob(16))),p.organization_id,p.id,
            CASE WHEN p.code IN ('BOSS','DEVELOPER') THEN 'all_orders' ELSE 'current_position' END,
            'open',?,?
     FROM positions p WHERE p.organization_id=?`,
  ).bind(now, now, organizationId).run();
}

export function meta() {
  return [{ title: "岗位设置 | International TMS" }];
}
