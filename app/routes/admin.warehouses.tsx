import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/admin.warehouses";
import { hashPassword } from "../lib/crypto.server";
import { positionRoleCodeSql, roleCodeForPosition } from "../lib/position-role";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
import { ActionToast } from "../components/ActionToast";
import { requireSessionUser } from "../lib/auth.server";
import { canAccessWarehouseAdministration } from "../lib/admin-navigation";
import { validateEmail, validatePassword, validatePhone, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import {
  validateWarehousePasswordReset,
  warehousePasswordResetRequested,
} from "../lib/warehouse-admin";
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
  warehouse_operate_enabled: number;
  warehouse_manage_enabled: number;
  active_warehouse_count: number;
};
type Access = {
  id: string;
  warehouse_id: string;
  user_id: string;
  display_name: string;
  email: string;
  phone: string | null;
  status: string;
  last_login_at: string | null;
  department_name: string | null;
  position_name: string | null;
  access_level: string;
  updated_at: string;
};
type Region = {
  category: "country" | "province" | "city";
  code: string;
  name: string;
  parent_code: string | null;
};

const levelLabels: Record<string, string> = {
  viewer: "仅查看",
  operator: "现场操作",
  manager: "仓库管理员",
};

const warehousePortalProfiles: Record<WarehouseRole, { name: string; modules: string[] }> = {
  domestic_collection: {
    name: "国内仓作业门户",
    modules: ["验收收货", "二次打包与贴标", "待配载池", "创建装车任务", "装车与出库", "库存与异常"],
  },
  port: {
    name: "国内仓作业门户",
    modules: ["验收收货", "二次打包与贴标", "待配载池", "创建装车任务", "装车与出库", "库存与异常"],
  },
  overseas_destination: {
    name: "境外仓作业门户",
    modules: ["验收收货", "客户扫码自提签收", "库存与异常"],
  },
};

async function validateWarehouseAccountBinding({
  organizationId,
  userId,
  accessLevel,
  excludeWarehouseId = "",
}: {
  organizationId: string;
  userId: string;
  accessLevel: string;
  excludeWarehouseId?: string;
}) {
  const [member, permissions, conflictingAccess] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id
       FROM memberships m
       JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
       WHERE m.organization_id=? AND m.user_id=? AND m.status='active'
       LIMIT 1`,
    ).bind(organizationId, userId).first(),
    env.DB.prepare(
      `SELECT DISTINCT rp.permission_code
       FROM memberships m
       JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
       JOIN roles r ON r.organization_id=m.organization_id AND r.code=${positionRoleCodeSql("p.code")} AND r.status='active'
       JOIN role_permissions rp ON rp.role_id=r.id
       WHERE m.organization_id=? AND m.user_id=? AND m.status='active'`,
    ).bind(organizationId, userId).all<{ permission_code: string }>(),
    env.DB.prepare(
      `SELECT w.name
       FROM warehouse_user_access a
       JOIN warehouses w ON w.id=a.warehouse_id AND w.organization_id=a.organization_id
       WHERE a.organization_id=? AND a.user_id=? AND w.status='active' AND a.warehouse_id<>?
       ORDER BY w.code
       LIMIT 1`,
    ).bind(organizationId, userId, excludeWarehouseId).first<{ name: string }>(),
  ]);
  if (!member) return "所选账号不是当前组织的有效成员";
  const permissionSet = new Set(permissions.results.map((item) => item.permission_code));
  if (!permissionSet.has("warehouse.view")) return "所选账号尚未开通仓库端登录权限";
  if (accessLevel !== "viewer" && !permissionSet.has("warehouse.operate"))
    return "所选账号尚未开通仓库现场操作权限";
  if (permissionSet.has("warehouse.manage"))
    return "全仓管理员无需绑定单一仓库，请选择普通仓库作业账号";
  if (conflictingAccess) return `所选账号已绑定启用仓库“${conflictingAccess.name}”，一个普通账号只能绑定一个启用仓库`;
  return null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request);
  if (!canAccessWarehouseAdministration(current.permissions)) {
    throw new Response("没有权限查看仓库管理", { status: 403 });
  }
  const canManage = current.permissions.includes("warehouse.manage");
  const [warehouses, users, access, regions] = await Promise.all([
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
          JOIN positions p2 ON p2.id=m2.position_id AND p2.organization_id=m2.organization_id AND p2.status='active'
          JOIN roles r2 ON r2.organization_id=m2.organization_id AND r2.code=${positionRoleCodeSql("p2.code")} AND r2.status='active'
          JOIN role_permissions rp ON rp.role_id=r2.id
          WHERE m2.organization_id=? AND m2.user_id=u.id AND m2.status='active'
            AND rp.permission_code='warehouse.view'
        ) THEN 1 ELSE 0 END warehouse_enabled,
        CASE WHEN EXISTS(
          SELECT 1 FROM memberships m2
          JOIN positions p2 ON p2.id=m2.position_id AND p2.organization_id=m2.organization_id AND p2.status='active'
          JOIN roles r2 ON r2.organization_id=m2.organization_id AND r2.code=${positionRoleCodeSql("p2.code")} AND r2.status='active'
          JOIN role_permissions rp ON rp.role_id=r2.id
          WHERE m2.organization_id=? AND m2.user_id=u.id AND m2.status='active'
            AND rp.permission_code='warehouse.operate'
        ) THEN 1 ELSE 0 END warehouse_operate_enabled,
        CASE WHEN EXISTS(
          SELECT 1 FROM memberships m2
          JOIN positions p2 ON p2.id=m2.position_id AND p2.organization_id=m2.organization_id AND p2.status='active'
          JOIN roles r2 ON r2.organization_id=m2.organization_id AND r2.code=${positionRoleCodeSql("p2.code")} AND r2.status='active'
          JOIN role_permissions rp ON rp.role_id=r2.id
          WHERE m2.organization_id=? AND m2.user_id=u.id AND m2.status='active'
            AND rp.permission_code='warehouse.manage'
        ) THEN 1 ELSE 0 END warehouse_manage_enabled,
        (SELECT COUNT(*)
         FROM warehouse_user_access a2
         JOIN warehouses w2 ON w2.id=a2.warehouse_id AND w2.organization_id=a2.organization_id
         WHERE a2.organization_id=? AND a2.user_id=u.id AND w2.status='active') active_warehouse_count
       FROM users u
       JOIN memberships m ON m.user_id=u.id AND m.organization_id=?
       LEFT JOIN departments d ON d.id=m.department_id
       WHERE u.status='active'
       ORDER BY u.display_name`,
    )
      .bind(
        current.organizationId,
        current.organizationId,
        current.organizationId,
        current.organizationId,
        current.organizationId,
      )
      .all<User>(),
    env.DB.prepare(
      `SELECT a.id,a.warehouse_id,a.user_id,u.display_name,u.email,u.phone,u.status,u.last_login_at,
        (SELECT d.name
           FROM memberships membership
           LEFT JOIN departments d
             ON d.id=membership.department_id AND d.organization_id=membership.organization_id
          WHERE membership.organization_id=a.organization_id AND membership.user_id=a.user_id
            AND membership.status='active'
          ORDER BY membership.created_at LIMIT 1) department_name,
        (SELECT p.name
           FROM memberships membership
           LEFT JOIN positions p
             ON p.id=membership.position_id AND p.organization_id=membership.organization_id
          WHERE membership.organization_id=a.organization_id AND membership.user_id=a.user_id
            AND membership.status='active'
          ORDER BY membership.created_at LIMIT 1) position_name,
        a.access_level,a.updated_at
       FROM warehouse_user_access a
       JOIN users u ON u.id=a.user_id
       WHERE a.organization_id=?
       ORDER BY u.display_name`,
    )
      .bind(current.organizationId)
      .all<Access>(),
    env.DB.prepare(
      `SELECT category,code,name,parent_code
       FROM reference_data
       WHERE organization_id=? AND category IN ('country','province','city') AND status='active'
       ORDER BY CASE category WHEN 'country' THEN 1 WHEN 'province' THEN 2 ELSE 3 END,sort_order,name`,
    )
      .bind(current.organizationId)
      .all<Region>(),
  ]);
  return {
    current,
    warehouses: warehouses.results,
    users: canManage ? users.results : [],
    access: canManage ? access.results : [],
    regions: regions.results,
    accessCount: warehouses.results.reduce((sum, warehouse) => sum + Number(warehouse.user_count || 0), 0),
    canManage,
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
    const warehouse = await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND organization_id=?")
        .bind(warehouseId, current.organizationId)
        .first();
    if (!warehouse) return { formError: "仓库不存在" };
    if (!Object.hasOwn(levelLabels, level)) return { formError: "仓库权限无效" };
    const bindingProblem = await validateWarehouseAccountBinding({
      organizationId: current.organizationId,
      userId,
      accessLevel: level,
      excludeWarehouseId: warehouseId,
    });
    if (bindingProblem) return { formError: bindingProblem };
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
    const result=await env.DB.prepare("DELETE FROM warehouse_user_access WHERE id=? AND organization_id=?")
      .bind(accessId, current.organizationId)
      .run();
    if(!Number(result.meta?.changes||0))return{formError:"仓库权限已被其他人移除，请刷新后查看"};
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
      status = valueOf(form, "status"),
      warehouse = await env.DB.prepare(
        "SELECT status FROM warehouses WHERE id=? AND organization_id=?",
      )
        .bind(id, current.organizationId)
        .first<{ status: string }>();
    if (!['active','disabled'].includes(status)) return { formError: "仓库目标状态无效" };
    if (!warehouse) return { formError: "仓库不存在" };
    if (warehouse.status === status) return { formError: status === "active" ? "仓库已启用" : "仓库已停用" };
    const result = await env.DB.prepare(
      "UPDATE warehouses SET status=?,updated_at=? WHERE id=? AND organization_id=? AND status=?",
    )
      .bind(status, now, id, current.organizationId, warehouse.status)
      .run();
    if (!Number(result.meta?.changes || 0)) return { formError: "仓库状态已被其他人修改，请刷新后查看" };
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
    provinceCode = valueOf(form, "province").toUpperCase(),
    cityCode = valueOf(form, "cityCode").toUpperCase(),
    submittedCity = valueOf(form, "city"),
    address = valueOf(form, "address");
  if (
    !/^[A-Z0-9-]{2,24}$/.test(code) ||
    name.length < 2 ||
    name.length > 80 ||
    !/^[A-Z0-9-]{2,12}$/.test(country) ||
    !isWarehouseRole(roleValue)
  )
    return { formError: "请填写有效的仓库代码、名称、角色和行政区划" };

  const [countryRegion, provinceCount] = await Promise.all([
    env.DB.prepare(
      `SELECT code,name
       FROM reference_data
       WHERE organization_id=? AND category='country' AND code=? AND status='active'
       LIMIT 1`,
    ).bind(current.organizationId, country).first<{ code: string; name: string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) count
       FROM reference_data
       WHERE organization_id=? AND category='province' AND parent_code=? AND status='active'`,
    ).bind(current.organizationId, country).first<{ count: number }>(),
  ]);
  if (!countryRegion) return { formError: "所选国家 / 地区不存在或已停用，请重新选择" };

  let resolvedCity = submittedCity;
  if (Number(provinceCount?.count || 0) > 0) {
    if (!provinceCode) return { formError: "请选择省 / 州" };
    const province = await env.DB.prepare(
      `SELECT code
       FROM reference_data
       WHERE organization_id=? AND category='province' AND code=? AND parent_code=? AND status='active'
       LIMIT 1`,
    ).bind(current.organizationId, provinceCode, country).first<{ code: string }>();
    if (!province) return { formError: "所选省 / 州不属于当前国家或已停用，请重新选择" };

    const cityCount = await env.DB.prepare(
      `SELECT COUNT(*) count
       FROM reference_data
       WHERE organization_id=? AND category='city' AND parent_code=? AND status='active'`,
    ).bind(current.organizationId, provinceCode).first<{ count: number }>();
    if (Number(cityCount?.count || 0) > 0) {
      if (!cityCode) return { formError: "请选择城市" };
      const cityRegion = await env.DB.prepare(
        `SELECT code,name
         FROM reference_data
         WHERE organization_id=? AND category='city' AND code=? AND parent_code=? AND status='active'
         LIMIT 1`,
      ).bind(current.organizationId, cityCode, provinceCode).first<{ code: string; name: string }>();
      if (!cityRegion) return { formError: "所选城市不属于当前省 / 州或已停用，请重新选择" };
      resolvedCity = cityRegion.name;
    } else {
      resolvedCity = "";
    }
  } else if (!provinceCode && !cityCode && intent === "create") {
    resolvedCity = "";
  }

  try {
    if (intent === "update") {
      const id = valueOf(form, "warehouseId");
      const passwordReset = {
        accountId: valueOf(form, "resetAccountId"),
        password: valueOf(form, "newPassword"),
        confirmPassword: valueOf(form, "confirmNewPassword"),
      };
      const passwordResetError = validateWarehousePasswordReset(passwordReset);
      if (passwordResetError) return { formError: passwordResetError };
      const resetRequested = warehousePasswordResetRequested(passwordReset);
      const account = resetRequested
        ? await env.DB.prepare(
            `SELECT a.user_id,u.email
               FROM warehouse_user_access a
               JOIN users u ON u.id=a.user_id
              WHERE a.organization_id=? AND a.warehouse_id=? AND a.user_id=?
              LIMIT 1`,
          ).bind(current.organizationId, id, passwordReset.accountId).first<{
            user_id: string;
            email: string;
          }>()
        : null;
      if (resetRequested && !account)
        return { formError: "所选账号不属于当前仓库，不能修改密码" };
      const statements: D1PreparedStatement[] = [env.DB.prepare(
        `UPDATE warehouses SET code=?,name=?,warehouse_role=?,country_code=?,city=?,address=?,updated_at=?
         WHERE id=? AND organization_id=?`,
      ).bind(
          code,
          name,
          roleValue,
          country,
          resolvedCity || null,
          address || null,
          now,
          id,
          current.organizationId,
        )];
      if (account) {
        statements.push(
          env.DB.prepare(
            "UPDATE users SET password_hash=?,failed_login_count=0,locked_until=NULL,updated_at=? WHERE id=?",
          ).bind(await hashPassword(passwordReset.password), now, account.user_id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(account.user_id),
        );
      }
      const results = await env.DB.batch(statements);
      if (!Number(results[0]?.meta?.changes || 0)) return { formError: "仓库不存在" };
      await writeAudit({
        request,
        action: "warehouse.update",
        resourceType: "warehouse",
        resourceId: id,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { code, name, warehouseRole: roleValue },
      });
      if (account) {
        await writeAudit({
          request,
          action: "warehouse.account.password.reset",
          resourceType: "user",
          resourceId: account.user_id,
          organizationId: current.organizationId,
          actorUserId: current.userId,
          metadata: { warehouseId: id, email: account.email },
        });
      }
      return {
        success: account
          ? `仓库资料已保存；账号 ${account.email} 的密码已修改，原登录会话已退出`
          : "仓库资料已保存",
      };
    }

    if (intent !== "create") return { formError: "无效的仓库操作" };
    const accountDisplayName = valueOf(form, "accountDisplayName"),
      accountEmail = valueOf(form, "accountEmail").toLowerCase(),
      accountPhone = valueOf(form, "accountPhone").trim(),
      password = valueOf(form, "password"),
      confirmPassword = valueOf(form, "confirmPassword"),
      emailError = validateEmail(accountEmail),
      passwordError = validatePassword(password);
    if (accountDisplayName.length < 2 || accountDisplayName.length > 60)
      return { formError: "账号名称需要填写 2-60 个字符" };
    if (emailError) return { formError: emailError };
    const phoneError = validatePhone(accountPhone,"仓库账号联系电话");
    if (phoneError) return { formError: phoneError };
    if (passwordError) return { formError: passwordError };
    if (password !== confirmPassword) return { formError: "两次输入的密码不一致" };

    const positionCode = roleValue === "overseas_destination" ? "OVERSEAS_WAREHOUSE" : "WAREHOUSE",
      roleCode = roleCodeForPosition(positionCode),
      [position, role] = await Promise.all([
        env.DB.prepare(
          `SELECT p.id position_id,p.name position_name,d.id department_id
           FROM positions p
           LEFT JOIN departments d ON d.organization_id=p.organization_id
             AND d.code=p.department_code AND d.status='active'
           WHERE p.organization_id=? AND p.code=? AND p.status='active'
           LIMIT 1`,
        ).bind(current.organizationId, positionCode).first<{
          position_id: string;
          position_name: string;
          department_id: string | null;
        }>(),
        env.DB.prepare(
          "SELECT id FROM roles WHERE organization_id=? AND code=? AND status='active' LIMIT 1",
        ).bind(current.organizationId, roleCode).first<{ id: string }>(),
      ]);
    if (!position || !role)
      return { formError: `系统尚未配置${roleValue === "overseas_destination" ? "境外仓库岗" : "仓库岗"}及其角色权限，请先在组织与权限中启用` };

    const id = crypto.randomUUID(),
      userId = crypto.randomUUID(),
      membershipId = crypto.randomUUID(),
      passwordHash = await hashPassword(password);
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
        country,
        resolvedCity || null,
        address || null,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO users(id,email,password_hash,display_name,phone,status,created_at,updated_at)
         VALUES(?,?,?,?,?,'active',?,?)`,
      ).bind(userId, accountEmail, passwordHash, accountDisplayName, accountPhone, now, now),
      env.DB.prepare(
        `INSERT INTO memberships(id,organization_id,user_id,title,status,created_at,updated_at,department_id,position_id)
         VALUES(?,?,?,?,'active',?,?,?,?)`,
      ).bind(
        membershipId,
        current.organizationId,
        userId,
        position.position_name,
        now,
        now,
        position.department_id,
        position.position_id,
      ),
      env.DB.prepare(
        "INSERT INTO membership_roles(membership_id,role_id) VALUES(?,?)",
      ).bind(membershipId, role.id),
      env.DB.prepare(
        `INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,granted_by_user_id,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        current.organizationId,
        id,
        userId,
        "manager",
        current.userId,
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
      metadata: { code, name, warehouseRole: roleValue, accountEmail, positionCode },
    });
    return { success: `${warehouseRoleLabels[roleValue]}“${name}”及登录账号 ${accountEmail} 已创建并启用` };
  } catch (error) {
    if (String(error).includes("UNIQUE")) return { formError: "仓库代码、登录邮箱或默认库位条码已存在" };
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
        {loaderData.canManage && <Modal title="新增仓库" triggerLabel="＋ 新增仓库" closeSignal={actionData?.success} size="wide">
          <WarehouseForm busy={busy} regions={loaderData.regions} />
        </Modal>}
      </header>
      <ActionToast data={actionData} />
      {!loaderData.canManage && <div className="notice info">当前岗位拥有“查看仓库管理”权限，本页为只读；仓库维护和账号授权需另行授予“管理仓库配置”。</div>}
      <section className="stats">
        <article><span>仓库总数</span><strong>{loaderData.warehouses.length}</strong><small>全部仓储场地</small></article>
        <article><span>启用仓库</span><strong>{active}</strong><small>允许现场作业</small></article>
        <article><span>境外目的仓</span><strong>{overseas}</strong><small>订单可选目的仓</small></article>
        <article><span>权限分配</span><strong>{loaderData.accessCount}</strong><small>用户仓库授权关系</small></article>
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
                      <Modal title={`查看仓库 · ${warehouse.name}`} triggerLabel="查看" triggerClassName="text-button" size="wide">
                        <WarehouseDetails warehouse={warehouse} accounts={loaderData.access.filter((item) => item.warehouse_id === warehouse.id)} />
                      </Modal>
                      {loaderData.canManage && <>
                        <Modal title={`编辑 ${warehouse.name}`} triggerLabel="编辑" triggerClassName="text-button" closeSignal={actionData?.success} size="wide" guardFormChanges>
                          <WarehouseForm warehouse={warehouse} busy={busy} regions={loaderData.regions} accounts={loaderData.access.filter((item) => item.warehouse_id === warehouse.id)} />
                        </Modal>
                        <Modal title={`${warehouse.name} · 用户权限`} triggerLabel="权限" triggerClassName="text-button" closeSignal={actionData?.success} size="wide">
                          <AccessManager warehouse={warehouse} users={loaderData.users} access={loaderData.access.filter((item) => item.warehouse_id === warehouse.id)} busy={busy} />
                        </Modal>
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="warehouseId" value={warehouse.id} />
                          <input type="hidden" name="status" value={warehouse.status === "active" ? "disabled" : "active"} />
                          {warehouse.status === "active"
                            ? <ConfirmAction title="停用仓库" description={`停用后 ${warehouse.name} 将不能接收新的仓库作业或被新订单选用；历史库存和作业审计永久保留。`} triggerLabel="停用" confirmLabel="确认停用仓库" confirmationKeyword={warehouse.code} pending={busy}/>
                            : <button className="text-button" disabled={busy}>启用</button>}
                        </Form>
                      </>}
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

function WarehouseForm({ warehouse, busy, regions, accounts = [] }: { warehouse?: Warehouse; busy: boolean; regions: Region[]; accounts?: Access[] }) {
  const [warehouseRole, setWarehouseRole] = useState<WarehouseRole>(warehouse?.warehouse_role ?? "domestic_collection");
  const [changePassword, setChangePassword] = useState(false);
  const countries = regions.filter((item) => item.category === "country"),
    matchedCity = regions.find((item) => item.category === "city" && (item.code === warehouse?.city || item.name === warehouse?.city)),
    [countryCode, setCountryCode] = useState(warehouse?.country_code ?? ""),
    initialProvinceCode = matchedCity?.parent_code ?? "",
    [provinceCode, setProvinceCode] = useState(initialProvinceCode),
    [cityCode, setCityCode] = useState(matchedCity?.code ?? ""),
    provinces = regions.filter((item) => item.category === "province" && item.parent_code === countryCode),
    cities = regions.filter((item) => item.category === "city" && item.parent_code === provinceCode),
    selectedCity = regions.find((item) => item.category === "city" && item.code === cityCode),
    profile = warehousePortalProfiles[warehouseRole];
  return (
    <Form method="post" className="stack warehouse-config-form">
      <input type="hidden" name="intent" value={warehouse ? "update" : "create"} />
      {warehouse && <input type="hidden" name="warehouseId" value={warehouse.id} />}
      <label className="field"><span>仓库名称</span><input name="name" defaultValue={warehouse?.name} required /></label>
      <label className="field"><span>仓库代码</span><input name="code" defaultValue={warehouse?.code} placeholder="URC-01" required /></label>
      <label className="field">
        <span>仓库类型</span>
        <select name="warehouseRole" value={warehouseRole} onChange={(event) => setWarehouseRole(event.currentTarget.value as WarehouseRole)} required>
          {warehouseRoles.map((role) => <option key={role} value={role}>{warehouseRoleLabels[role]}{role === "overseas_destination" ? "（境外仓模块）" : "（国内仓模块）"}</option>)}
        </select>
        <small>类型决定登录后的仓库门户模块和默认库区。</small>
      </label>
      <div className="warehouse-region-grid">
        <label className="field"><span>国家 / 地区</span><select name="country" value={countryCode} onChange={(event) => { setCountryCode(event.currentTarget.value); setProvinceCode(""); setCityCode(""); }} required><option value="">请选择国家 / 地区</option>{countries.map((item) => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label>
        <label className="field"><span>省 / 州</span><select name="province" value={provinceCode} onChange={(event) => { setProvinceCode(event.currentTarget.value); setCityCode(""); }} required={provinces.length > 0} disabled={!provinces.length}><option value="">{provinces.length ? "请选择省 / 州" : "当前国家暂无省 / 州"}</option>{provinces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label className="field"><span>城市</span><select name="cityCode" value={cityCode} onChange={(event) => setCityCode(event.currentTarget.value)} required={cities.length > 0} disabled={!cities.length}><option value="">{cities.length ? "请选择城市" : "当前省 / 州暂无城市"}</option>{cities.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <input type="hidden" name="city" value={selectedCity?.name ?? (cityCode ? warehouse?.city ?? "" : "")} />
      </div>
      {!warehouse && <section className="warehouse-account-create">
        <div className="warehouse-account-create__heading"><strong>仓库登录账号</strong><small>与仓库一起创建、授权并立即启用</small></div>
        <div className="warehouse-account-grid">
          <label className="field"><span>账号名称</span><input name="accountDisplayName" placeholder="例如：莫斯科仓账号" required /></label>
          <label className="field"><span>登录邮箱</span><input type="email" name="accountEmail" placeholder="warehouse@example.com" autoComplete="username" required /></label>
          <label className="field"><span>联系电话</span><input type="tel" inputMode="tel" name="accountPhone" maxLength={30} pattern="[+0-9 \(\)\-]{6,30}" required /></label>
          <label className="field"><span>初始密码</span><input type="password" name="password" minLength={12} autoComplete="new-password" required /></label>
          <label className="field"><span>确认密码</span><input type="password" name="confirmPassword" minLength={12} autoComplete="new-password" required /></label>
        </div>
        <small>密码至少 12 位，包含大小写字母和数字。账号自动获得与仓库类型匹配的岗位及门户。</small>
      </section>}
      {warehouse && <section className="warehouse-account-create warehouse-account-reset">
        <div className="warehouse-account-create__heading"><strong>仓库登录账号</strong><small>密码采用加密保存，无法查看原密码</small></div>
        {accounts.length ? <>
          <label className="check-field warehouse-password-toggle"><input type="checkbox" checked={changePassword} onChange={(event) => setChangePassword(event.currentTarget.checked)} />同时修改仓库账号密码</label>
          {changePassword && <div className="warehouse-account-grid">
            <label className="field"><span>需要修改的账号</span><select name="resetAccountId" required defaultValue={accounts.length === 1 ? accounts[0].user_id : ""}><option value="">请选择账号</option>{accounts.map((account) => <option key={account.user_id} value={account.user_id}>{account.display_name} · {account.email}</option>)}</select></label>
            <label className="field"><span>新密码</span><input type="password" name="newPassword" minLength={12} maxLength={128} autoComplete="new-password" required /><small>至少 12 位，包含大小写字母和数字</small></label>
            <label className="field"><span>确认新密码</span><input type="password" name="confirmNewPassword" minLength={12} maxLength={128} autoComplete="new-password" required /></label>
          </div>}
        </> : <p className="empty-state">该仓库尚未绑定登录账号，请先在“权限”中分配仓库用户。</p>}
      </section>}
      <section className="warehouse-module-preview" aria-live="polite">
        <div><strong>{profile.name}</strong><small>创建后自动启用</small></div>
        <ul>{profile.modules.map((module) => <li key={module}>{module}</li>)}</ul>
      </section>
      <label className="field warehouse-config-address"><span>详细地址</span><textarea name="address" rows={3} defaultValue={warehouse?.address ?? ""} /></label>
      <button className="primary" disabled={busy}>{warehouse ? "保存仓库" : "创建仓库与账号并启用"}</button>
    </Form>
  );
}

function WarehouseDetails({ warehouse, accounts }: { warehouse: Warehouse; accounts: Access[] }) {
  return <div className="warehouse-detail">
    <section className="warehouse-detail-grid" aria-label="仓库基本信息">
      <Info label="仓库名称" value={warehouse.name} />
      <Info label="仓库代码" value={warehouse.code} mono />
      <Info label="仓库类型" value={warehouseRoleLabels[warehouse.warehouse_role]} />
      <Info label="状态" value={warehouse.status === "active" ? "启用" : "停用"} />
      <Info label="国家 / 地区" value={warehouse.country_code || "—"} />
      <Info label="城市" value={warehouse.city || "—"} />
      <Info label="库区 / 库位" value={`${warehouse.zone_count} 个库区 / ${warehouse.location_count} 个库位`} />
      <Info label="详细地址" value={warehouse.address || "—"} wide />
    </section>
    <section className="warehouse-detail-accounts">
      <header><div><strong>仓库登录账号</strong><small>共 {accounts.length} 个授权账号</small></div><span className="status-pill">密码已加密保存</span></header>
      <div className="table-wrap"><table><thead><tr><th>账号</th><th>联系方式</th><th>组织归属</th><th>仓库权限</th><th>状态 / 最近登录</th></tr></thead><tbody>
        {accounts.length ? accounts.map((account) => <tr key={account.id}>
          <td><strong>{account.display_name}</strong><small><code>{account.email}</code></small></td>
          <td>{account.phone || "—"}</td>
          <td>{account.department_name || "未分配部门"}<small>{account.position_name || "未分配岗位"}</small></td>
          <td><span className="status-pill">{levelLabels[account.access_level] || account.access_level}</span></td>
          <td><span className={`status-pill ${account.status !== "active" ? "off" : ""}`}>{account.status === "active" ? "正常" : "停用"}</span><small>{account.last_login_at ? `最近登录 ${formatWarehouseDateTime(account.last_login_at)}` : "尚未登录"}</small></td>
        </tr>) : <tr><td colSpan={5} className="empty-state">该仓库尚未绑定登录账号。</td></tr>}
      </tbody></table></div>
    </section>
  </div>;
}

function Info({ label, value, mono = false, wide = false }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return <div className={wide ? "wide" : undefined}><span>{label}</span>{mono ? <code>{value}</code> : <strong>{value}</strong>}</div>;
}

function formatWarehouseDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
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
            {users.map((user) => {
              const unavailableReason = user.warehouse_manage_enabled
                ? "全仓管理员无需绑定"
                : !user.warehouse_enabled
                  ? "尚未开通仓库端"
                  : user.active_warehouse_count > 0 && !access.some((row) => row.user_id === user.id)
                    ? "已绑定其他启用仓库"
                    : "";
              return <option key={user.id} value={user.id} disabled={Boolean(unavailableReason)}>{user.display_name} · {user.email}{unavailableReason ? `（${unavailableReason}）` : ""}</option>;
            })}
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
            <Form method="post"><input type="hidden" name="intent" value="revoke" /><input type="hidden" name="accessId" value={row.id} /><ConfirmAction title="移除仓库授权" description={`移除后 ${row.display_name} 将不能再进入本仓库办理作业；既有操作与审计记录永久保留。`} triggerLabel="移除" confirmLabel="确认移除授权" pending={busy}/></Form>
          </div>
        ))}
      </div>
      {!access.length && <p className="empty-state">该仓库尚未分配具体用户。</p>}
      <p className="access-note">仓库级授权控制用户可进入哪个仓库；账号仍需在“岗位权限”中拥有仓库端查看或操作权限。</p>
    </div>
  );
}

export function meta() {
  return [{ title: "仓库管理 | International TMS" }];
}
