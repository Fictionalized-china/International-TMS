import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.warehouses";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import {
  defaultZonesForRole,
  isWarehouseRole,
  warehouseRoleLabels,
  warehouseRoles,
  type WarehouseRole,
} from "../lib/road-master-data";

type Warehouse = {
  id: string;
  code: string;
  name: string;
  warehouse_role: WarehouseRole;
  country_code: string | null;
  city: string | null;
  address: string | null;
  status: string;
  zone_count: number;
  location_count: number;
  user_count: number;
};
type User = {
  id: string;
  display_name: string;
  email: string;
  department_name: string | null;
  warehouse_enabled: number;
};
type Access = {
  id: string;
  warehouse_id: string;
  user_id: string;
  display_name: string;
  email: string;
  access_level: string;
  updated_at: string;
};

const levelLabels: Record<string, string> = {
  viewer: "仅查看",
  operator: "现场操作",
  manager: "仓库管理员",
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "warehouse.manage");
  const [warehouses, users, access] = await Promise.all([
    env.DB.prepare(
      `SELECT w.id,w.code,w.name,w.warehouse_role,w.country_code,w.city,w.address,w.status,
        COUNT(DISTINCT z.id) zone_count,COUNT(DISTINCT l.id) location_count,COUNT(DISTINCT a.user_id) user_count
       FROM warehouses w
       LEFT JOIN warehouse_zones z ON z.warehouse_id=w.id
       LEFT JOIN warehouse_locations l ON l.warehouse_id=w.id
       LEFT JOIN warehouse_user_access a ON a.warehouse_id=w.id
       WHERE w.organization_id=?
       GROUP BY w.id
       ORDER BY w.status DESC,
         CASE w.warehouse_role WHEN 'domestic_collection' THEN 10 WHEN 'port' THEN 20 ELSE 30 END,
         w.code`,
    )
      .bind(current.organizationId)
      .all<Warehouse>(),
    env.DB.prepare(
      `SELECT u.id,u.display_name,u.email,d.name department_name,
        CASE WHEN EXISTS(
          SELECT 1 FROM memberships m2
          JOIN membership_roles mr ON mr.membership_id=m2.id
          JOIN role_permissions rp ON rp.role_id=mr.role_id
          WHERE m2.organization_id=? AND m2.user_id=u.id AND rp.permission_code='warehouse.view'
        ) THEN 1 ELSE 0 END warehouse_enabled
       FROM users u
       JOIN memberships m ON m.user_id=u.id AND m.organization_id=?
       LEFT JOIN departments d ON d.id=m.department_id
       WHERE u.status='active'
       ORDER BY u.display_name`,
    )
      .bind(current.organizationId, current.organizationId)
      .all<User>(),
    env.DB.prepare(
      `SELECT a.id,a.warehouse_id,a.user_id,u.display_name,u.email,a.access_level,a.updated_at
       FROM warehouse_user_access a
       JOIN users u ON u.id=a.user_id
       WHERE a.organization_id=?
       ORDER BY u.display_name`,
    )
      .bind(current.organizationId)
      .all<Access>(),
  ]);
  return {
    current,
    warehouses: warehouses.results,
    users: users.results,
    access: access.results,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "warehouse.manage"),
    form = await request.formData(),
    intent = valueOf(form, "intent"),
    now = new Date().toISOString();

  if (intent === "grant") {
    const warehouseId = valueOf(form, "warehouseId"),
      userId = valueOf(form, "userId"),
      level = valueOf(form, "accessLevel");
    const [warehouse, member] = await Promise.all([
      env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND organization_id=?")
        .bind(warehouseId, current.organizationId)
        .first(),
      env.DB.prepare("SELECT id FROM memberships WHERE organization_id=? AND user_id=?")
        .bind(current.organizationId, userId)
        .first(),
    ]);
    if (!warehouse || !member) return { formError: "仓库或用户不存在" };
    if (!Object.hasOwn(levelLabels, level)) return { formError: "仓库权限无效" };
    await env.DB.prepare(
      `INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,granted_by_user_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(warehouse_id,user_id) DO UPDATE SET
         access_level=excluded.access_level,granted_by_user_id=excluded.granted_by_user_id,updated_at=excluded.updated_at`,
    )
      .bind(
        crypto.randomUUID(),
        current.organizationId,
        warehouseId,
        userId,
        level,
        current.userId,
        now,
        now,
      )
      .run();
    await writeAudit({
      request,
      action: "warehouse.access.grant",
      resourceType: "warehouse",
      resourceId: warehouseId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { userId, level },
    });
    return { success: "仓库权限已保存" };
  }

  if (intent === "revoke") {
    const accessId = valueOf(form, "accessId"),
      row = await env.DB.prepare(
        "SELECT warehouse_id,user_id FROM warehouse_user_access WHERE id=? AND organization_id=?",
      )
        .bind(accessId, current.organizationId)
        .first<{ warehouse_id: string; user_id: string }>();
    if (!row) return { formError: "仓库权限不存在" };
    await env.DB.prepare("DELETE FROM warehouse_user_access WHERE id=? AND organization_id=?")
      .bind(accessId, current.organizationId)
      .run();
    await writeAudit({
      request,
      action: "warehouse.access.revoke",
      resourceType: "warehouse",
      resourceId: row.warehouse_id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { userId: row.user_id },
    });
    return { success: "仓库权限已移除" };
  }

  if (intent === "toggle") {
    const id = valueOf(form, "warehouseId"),
      warehouse = await env.DB.prepare(
        "SELECT status FROM warehouses WHERE id=? AND organization_id=?",
      )
        .bind(id, current.organizationId)
        .first<{ status: string }>();
    if (!warehouse) return { formError: "仓库不存在" };
    const status = warehouse.status === "active" ? "disabled" : "active";
    await env.DB.prepare(
      "UPDATE warehouses SET status=?,updated_at=? WHERE id=? AND organization_id=?",
    )
      .bind(status, now, id, current.organizationId)
      .run();
    await writeAudit({
      request,
      action: `warehouse.${status}`,
      resourceType: "warehouse",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
    });
    return { success: status === "active" ? "仓库已启用" : "仓库已停用" };
  }

  const code = valueOf(form, "code").toUpperCase(),
    name = valueOf(form, "name"),
    roleValue = valueOf(form, "warehouseRole"),
    country = valueOf(form, "country").toUpperCase(),
    city = valueOf(form, "city"),
    address = valueOf(form, "address");
  if (
    !/^[A-Z0-9-]{2,24}$/.test(code) ||
    name.length < 2 ||
    name.length > 80 ||
    (country && !/^[A-Z]{2}$/.test(country)) ||
    !isWarehouseRole(roleValue)
  )
    return { formError: "请填写有效的仓库代码、名称、角色和国家代码" };

  try {
    if (intent === "update") {
      const id = valueOf(form, "warehouseId");
      const result = await env.DB.prepare(
        `UPDATE warehouses SET code=?,name=?,warehouse_role=?,country_code=?,city=?,address=?,updated_at=?
         WHERE id=? AND organization_id=?`,
      )
        .bind(
          code,
          name,
          roleValue,
          country || null,
          city || null,
          address || null,
          now,
          id,
          current.organizationId,
        )
        .run();
      if (!result.meta.changes) return { formError: "仓库不存在" };
      await writeAudit({
        request,
        action: "warehouse.update",
        resourceType: "warehouse",
        resourceId: id,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { code, name, warehouseRole: roleValue },
      });
      return { success: "仓库资料已保存" };
    }

    if (intent !== "create") return { formError: "无效的仓库操作" };
    const id = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,country_code,city,address,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'active',?,?)`,
      ).bind(
        id,
        current.organizationId,
        code,
        name,
        roleValue,
        country || null,
        city || null,
        address || null,
        now,
        now,
      ),
    ];
    for (const zone of defaultZonesForRole(roleValue)) {
      const zoneId = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          `INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,zone_type,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,'active',?,?)`,
        ).bind(
          zoneId,
          current.organizationId,
          id,
          zone.code,
          zone.name,
          zone.type,
          now,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,barcode,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,'active',?,?)`,
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          id,
          zoneId,
          zone.locationCode,
          zone.locationName,
          `${code}-${zone.locationCode}`,
          now,
          now,
        ),
      );
    }
    await env.DB.batch(statements);
    await writeAudit({
      request,
      action: "warehouse.create",
      resourceType: "warehouse",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { code, name, warehouseRole: roleValue },
    });
    return { success: `${warehouseRoleLabels[roleValue]}“${name}”已创建，并生成默认库区和库位` };
  } catch (error) {
    if (String(error).includes("UNIQUE")) return { formError: "仓库代码或默认库位条码已存在" };
    throw error;
  }
}

export default function AdminWarehouses({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle",
    active = loaderData.warehouses.filter((item) => item.status === "active").length,
    overseas = loaderData.warehouses.filter(
      (item) => item.warehouse_role === "overseas_destination" && item.status === "active",
    ).length;
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">WAREHOUSE ADMINISTRATION</p>
          <h1>仓库管理</h1>
          <p>统一维护国内集货仓、口岸仓和境外目的仓，并分配现场访问权限。</p>
        </div>
        <Modal title="新增仓库" triggerLabel="＋ 新增仓库" closeSignal={actionData?.success}>
          <WarehouseForm busy={busy} />
        </Modal>
      </header>
      {(actionData?.success || actionData?.formError) && (
        <div className={`alert ${actionData.formError ? "error" : "success"}`}>
          {actionData.formError ?? actionData.success}
        </div>
      )}
      <section className="stats">
        <article><span>仓库总数</span><strong>{loaderData.warehouses.length}</strong><small>全部仓储场地</small></article>
        <article><span>启用仓库</span><strong>{active}</strong><small>允许现场作业</small></article>
        <article><span>境外目的仓</span><strong>{overseas}</strong><small>订单可选目的仓</small></article>
        <article><span>权限分配</span><strong>{loaderData.access.length}</strong><small>用户仓库授权关系</small></article>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div><h2>仓库列表</h2><p>新增仓库时自动创建与角色匹配的默认库区和库位。</p></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>仓库</th><th>角色</th><th>地址</th><th>库区/库位</th><th>授权用户</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {loaderData.warehouses.map((warehouse) => (
                <tr key={warehouse.id}>
                  <td><strong>{warehouse.name}</strong><small>{warehouse.code}</small></td>
                  <td><span className="status-pill">{warehouseRoleLabels[warehouse.warehouse_role]}</span></td>
                  <td>{[warehouse.country_code, warehouse.city, warehouse.address].filter(Boolean).join(" · ") || "—"}</td>
                  <td>{warehouse.zone_count} 个库区<small>{warehouse.location_count} 个库位</small></td>
                  <td>{warehouse.user_count} 人</td>
                  <td><span className={`status-pill ${warehouse.status !== "active" ? "off" : ""}`}>{warehouse.status === "active" ? "启用" : "停用"}</span></td>
                  <td>
                    <div className="page-actions">
                      <Modal title={`编辑 ${warehouse.name}`} triggerLabel="编辑" triggerClassName="text-button" closeSignal={actionData?.success}>
                        <WarehouseForm warehouse={warehouse} busy={busy} />
                      </Modal>
                      <Modal title={`${warehouse.name} · 用户权限`} triggerLabel="权限" triggerClassName="text-button" closeSignal={actionData?.success} size="wide">
                        <AccessManager warehouse={warehouse} users={loaderData.users} access={loaderData.access.filter((item) => item.warehouse_id === warehouse.id)} busy={busy} />
                      </Modal>
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggle" />
                        <input type="hidden" name="warehouseId" value={warehouse.id} />
                        <button className="text-button" disabled={busy}>{warehouse.status === "active" ? "停用" : "启用"}</button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function WarehouseForm({ warehouse, busy }: { warehouse?: Warehouse; busy: boolean }) {
  return (
    <Form method="post" className="stack warehouse-config-form">
      <input type="hidden" name="intent" value={warehouse ? "update" : "create"} />
      {warehouse && <input type="hidden" name="warehouseId" value={warehouse.id} />}
      <label className="field"><span>仓库名称</span><input name="name" defaultValue={warehouse?.name} required /></label>
      <label className="field"><span>仓库代码</span><input name="code" defaultValue={warehouse?.code} placeholder="URC-01" required /></label>
      <label className="field">
        <span>仓库角色</span>
        <select name="warehouseRole" defaultValue={warehouse?.warehouse_role ?? "domestic_collection"} required>
          {warehouseRoles.map((role) => <option key={role} value={role}>{warehouseRoleLabels[role]}</option>)}
        </select>
        <small>角色决定订单和配载页面能否选择该仓库，也决定新仓库的默认库区。</small>
      </label>
      <div className="form-grid compact">
        <label className="field"><span>国家代码</span><input name="country" defaultValue={warehouse?.country_code ?? ""} placeholder="CN" /></label>
        <label className="field"><span>城市</span><input name="city" defaultValue={warehouse?.city ?? ""} /></label>
      </div>
      <label className="field warehouse-config-address"><span>详细地址</span><textarea name="address" rows={2} defaultValue={warehouse?.address ?? ""} /></label>
      <button className="primary" disabled={busy}>{warehouse ? "保存仓库" : "创建仓库"}</button>
    </Form>
  );
}

function AccessManager({ warehouse, users, access, busy }: { warehouse: Warehouse; users: User[]; access: Access[]; busy: boolean }) {
  return (
    <div className="access-manager">
      <Form method="post" className="access-grant">
        <input type="hidden" name="intent" value="grant" />
        <input type="hidden" name="warehouseId" value={warehouse.id} />
        <label className="field">
          <span>用户</span>
          <select name="userId" required>
            <option value="">请选择用户</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}{!user.warehouse_enabled ? "（尚未授予仓库端登录角色）" : ""}</option>)}
          </select>
        </label>
        <label className="field"><span>仓库权限</span><select name="accessLevel"><option value="viewer">仅查看</option><option value="operator">现场操作</option><option value="manager">仓库管理员</option></select></label>
        <button className="primary" disabled={busy}>保存权限</button>
      </Form>
      <div className="access-list">
        {access.map((row) => (
          <div key={row.id}>
            <div><strong>{row.display_name}</strong><small>{row.email}</small></div>
            <span className="status-pill">{levelLabels[row.access_level]}</span>
            <Form method="post"><input type="hidden" name="intent" value="revoke" /><input type="hidden" name="accessId" value={row.id} /><button className="text-button danger" disabled={busy}>移除</button></Form>
          </div>
        ))}
      </div>
      {!access.length && <p className="empty-state">该仓库尚未分配具体用户。</p>}
      <p className="access-note">仓库级授权控制用户可进入哪个仓库；用户仍需在“角色权限”中拥有仓库端查看或操作权限。</p>
    </div>
  );
}

export function meta() {
  return [{ title: "仓库管理 | International TMS" }];
}
