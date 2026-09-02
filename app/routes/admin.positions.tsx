import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.positions";
import { ConfirmAction } from "../components/ConfirmAction";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { roleCodeForPosition } from "../lib/position-role";
import { isProtectedAccessRole } from "../lib/permission-blocks";
import { inspectAccessControlSchema } from "../lib/access-control-schema.server";

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
  role_codes: string | null;
};

const permissionLabels: Record<string, string> = {
  "dashboard.view": "首页",
  "order.view": "查看订单",
  "order.manage": "办理订单",
  "shipment.view": "查看运单",
  "shipment.manage": "管理运单",
  "warehouse.view": "查看仓库",
  "warehouse.operate": "仓库操作",
  "billing.view": "查看费用",
  "billing.manage": "费用结算",
  "customer.view": "查看客户",
  "customer.manage": "管理客户",
  "sales.view": "销售",
  "sales.manage": "销售管理",
  "quote.view": "报价",
  "quote.manage": "报价管理",
  "workflow.view": "业务工作流",
  "carrier.view": "查看承运商",
  "carrier.manage": "管理承运商",
  "pricing.view": "物流产品",
  "pricing.manage": "产品管理",
  "audit.view": "审计",
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "user.view");
  await ensurePositionsSeed(current.organizationId);
  const [positions, departments, members] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id,p.code,p.name,p.department_code,d.name department_name,p.status,p.sort_order,
              CASE p.code
                WHEN 'BOSS' THEN 'boss'
                WHEN 'DEVELOPER' THEN 'developer'
                WHEN 'DOC' THEN 'pos_doc'
                WHEN 'CS' THEN 'pos_customer_service'
                WHEN 'FINANCE' THEN 'pos_finance'
                WHEN 'SALES' THEN 'pos_sales'
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
              COALESCE(pps.default_filter,'open') portal_default_filter
       FROM positions p
       LEFT JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code
       LEFT JOIN position_portal_settings pps ON pps.organization_id=p.organization_id AND pps.position_id=p.id
       WHERE p.organization_id=?
       ORDER BY p.sort_order,p.name`,
    ).bind(current.organizationId).all<Position>(),
    env.DB.prepare(
      "SELECT code,name FROM departments WHERE organization_id=? AND status='active' ORDER BY sort_order,name",
    ).bind(current.organizationId).all<Department>(),
    env.DB.prepare(
      `SELECT m.id membership_id,u.id user_id,u.display_name,u.email,m.title,m.position_id,p.name position_name,
              GROUP_CONCAT(r.code) role_codes
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       LEFT JOIN positions p ON p.id=m.position_id
       LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id
       WHERE m.organization_id=? AND m.status='active' AND u.status='active'
       GROUP BY m.id
       ORDER BY u.display_name`,
    ).bind(current.organizationId).all<Member>(),
  ]);
  return {
    current,
    positions: positions.results,
    departments: departments.results,
    members: members.results,
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
      `SELECT m.id,GROUP_CONCAT(DISTINCT r.code) role_codes
       FROM memberships m LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id
       WHERE m.id=? AND m.organization_id=? AND m.status='active' GROUP BY m.id`,
    ).bind(membershipId, current.organizationId).first<{ id: string; role_codes: string | null }>();
    if (!position || !membership) return { formError: "请选择有效账号和岗位" };
    if (isProtectedAccessRole((membership.role_codes ?? "").split(",").filter(Boolean))) {
      return { formError: "老板/所有者账户的岗位和角色不可修改" };
    }
    if (["BOSS", "DEVELOPER"].includes(position.code) && !isProtectedAccessRole(current.roleCodes)) {
      return { formError: "只有老板/所有者可以分配受保护岗位" };
    }
    const roleCode = roleCodeForPosition(position.code);
    const role = await env.DB.prepare(
      "SELECT id FROM roles WHERE organization_id=? AND code=? AND status='active'",
    ).bind(current.organizationId, roleCode).first<{ id: string }>();
    if (!role) return { formError: `岗位 ${position.name} 还没有对应角色，请先执行数据库迁移或在角色权限中补齐` };
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
      "SELECT status FROM positions WHERE id=? AND organization_id=?",
    ).bind(id, current.organizationId).first<{ status: string }>();
    if (!row) return { formError: "岗位不存在" };
    if (row.status === next) return { formError: next === "active" ? "岗位已启用" : "岗位已停用" };
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
    if (!["open", "all", "blocked", "overdue"].includes(defaultFilter))
      return { formError: "任务工作台配置无效" };
    const position = await env.DB.prepare("SELECT id FROM positions WHERE id=? AND organization_id=?").bind(positionId, current.organizationId).first();
    if (!position) return { formError: "岗位不存在" };
    await env.DB.prepare(
      `INSERT INTO position_portal_settings(id,organization_id,position_id,order_scope,default_filter,updated_by_user_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,position_id) DO UPDATE SET
         order_scope=excluded.order_scope,default_filter=excluded.default_filter,
         updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(), current.organizationId, positionId, "current_position", defaultFilter, current.userId, now, now).run();
    return { success: "任务工作台默认筛选已更新；订单范围由角色/账户权限积木控制" };
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
  await env.DB.prepare(
    `INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
     VALUES(?,?,?,?,?,'active',?,?,?)
     ON CONFLICT(organization_id,code) DO UPDATE SET
       name=excluded.name,department_code=excluded.department_code,status='active',
       sort_order=excluded.sort_order,updated_at=excluded.updated_at`,
  ).bind(crypto.randomUUID(), current.organizationId, code, name, departmentCode, sortOrder, now, now).run();
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
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">POSITION ACCESS</p>
          <h1>岗位管理</h1>
          <p>按岗位维护权限边界，并把账号绑定到对应岗位；老板岗位默认拥有所有权限。</p>
        </div>
        <span className="status-pill">{loaderData.positions.length} 个岗位</span>
      </header>
      {(actionData?.success || actionData?.formError) && (
        <div className={`alert ${actionData.formError ? "error" : "success"}`}>
          {actionData.formError ?? actionData.success}
        </div>
      )}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>账号岗位绑定</h2>
            <p>岗位决定账号默认能进入哪些模块；特殊账号仍可在角色权限里叠加角色。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账号</th>
                <th>当前岗位</th>
                <th>已有角色</th>
                <th>调整岗位</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.members.map((member) => (
                <tr key={member.membership_id}>
                  <td>
                    <strong>{member.display_name}</strong>
                    <small>{member.email}{member.title ? ` · ${member.title}` : ""}</small>
                  </td>
                  <td>{member.position_name || "未绑定"}</td>
                  <td><small>{member.role_codes || "未分配角色"}</small></td>
                  <td>
                    {canManage ? (
                      <Form method="post" className="inline-form">
                        <input type="hidden" name="intent" value="assign_member_position" />
                        <input type="hidden" name="membershipId" value={member.membership_id} />
                        <select name="positionId" defaultValue={member.position_id || ""} required>
                          <option value="">选择岗位</option>
                          {loaderData.positions.filter((position) => position.status === "active").map((position) => (
                            <option key={position.id} value={position.id}>{position.department_name} / {position.name}</option>
                          ))}
                        </select>
                        <button className="secondary" disabled={busy}>保存</button>
                      </Form>
                    ) : (
                      "只读"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {canManage && (
        <section className="panel">
          <h2>新增或更新岗位</h2>
          <Form method="post" className="form-grid compact position-editor-form">
            <input type="hidden" name="intent" value="upsert" />
            <label className="field">
              <span>岗位名称</span>
              <input name="name" placeholder="例如：操作" required />
            </label>
            <label className="field">
              <span>岗位代码</span>
              <input name="code" placeholder="例如：OPERATION" required />
            </label>
            <label className="field">
              <span>归属部门</span>
              <select name="departmentCode" required>
                <option value="">选择归属部门</option>
                {loaderData.departments.map((department) => (
                  <option key={department.code} value={department.code}>{department.code} · {department.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>排序</span>
              <input name="sortOrder" type="number" step="1" defaultValue="100" />
            </label>
            <button className="primary" disabled={busy}>保存岗位</button>
          </Form>
        </section>
      )}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>岗位与权限范围</h2>
            <p>这里展示岗位对应角色的权限摘要；具体权限项仍在角色权限中维护。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>岗位</th>
                <th>部门</th>
                <th>对应角色</th>
                <th>模块权限</th>
                <th>任务工作台</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.positions.map((position) => {
                const permissions = (position.permissions || "")
                  .split(",")
                  .filter(Boolean)
                  .map((code) => permissionLabels[code] ?? code);
                return (
                  <tr key={position.id}>
                    <td>
                      <strong>{position.name}</strong>
                      <small>{position.code}</small>
                    </td>
                    <td>{position.department_code ? `${position.department_code} · ${position.department_name ?? ""}` : "未指定"}</td>
                    <td><code>{position.role_code}</code></td>
                    <td>
                      {position.code === "BOSS" ? (
                        <span className="status-pill success">所有权限</span>
                      ) : permissions.length ? (
                        <div className="chip-list compact">
                          {permissions.slice(0, 8).map((label) => <span key={label}>{label}</span>)}
                          {permissions.length > 8 && <span>+{permissions.length - 8}</span>}
                        </div>
                      ) : (
                        "未配置"
                      )}
                    </td>
                    <td>
                      {canManage ? <Form method="post" className="portal-setting-form">
                        <input type="hidden" name="intent" value="portal_settings" />
                        <input type="hidden" name="positionId" value={position.id} />
                        <span className="field-static-note">范围由权限积木控制</span>
                        <select name="defaultFilter" defaultValue={position.portal_default_filter}>
                          <option value="open">默认：未完成</option>
                          <option value="all">默认：全部</option>
                          <option value="blocked">默认：有阻断</option>
                          <option value="overdue">默认：即将/已经超时</option>
                        </select>
                        <button className="text-button" disabled={busy}>保存</button>
                      </Form> : <small>范围由权限积木控制</small>}
                    </td>
                    <td>
                      <span className={`status-pill ${position.status !== "active" ? "off" : ""}`}>
                        {position.status === "active" ? "启用" : "停用"}
                      </span>
                    </td>
                    <td>
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
    ["OPERATION", "单证（操作岗）", "OP", 20],
    ["TRACKING", "运踪岗", "OP", 30],
    ["CS", "客服岗", "OP", 40],
    ["BUSINESS_ROUTE", "商务报价岗", "BUS", 50],
    ["LOADING", "前端配载岗", "OP", 60],
    ["FINANCE_ACCOUNTING", "财务会计岗", "ACC", 70],
    ["CASHIER", "出纳岗", "ACC", 80],
    ["HR_ADMIN", "人事行政岗", "HR", 90],
    ["WAREHOUSE", "仓库岗", "OP", 110],
    ["OVERSEAS_WAREHOUSE", "境外仓库岗", "OP", 120],
  ];
  await env.DB.batch(defaults.map(([code, name, departmentCode, sort]) =>
    env.DB.prepare(
      `INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,department_code=excluded.department_code,sort_order=excluded.sort_order,updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(), organizationId, code, name, departmentCode, sort, now, now),
  ));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO position_portal_settings(id,organization_id,position_id,order_scope,default_filter,created_at,updated_at)
     SELECT lower(hex(randomblob(16))),p.organization_id,p.id,
            CASE WHEN p.code IN ('BOSS','DEVELOPER') THEN 'all_orders' ELSE 'current_position' END,
            'open',?,?
     FROM positions p WHERE p.organization_id=?`,
  ).bind(now, now, organizationId).run();
}

export function meta() {
  return [{ title: "岗位管理 | International TMS" }];
}
