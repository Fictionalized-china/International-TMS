import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  productionAccountBlueprint,
  type ProductionAccountBlueprint,
} from "../app/lib/production-account-blueprint.ts";
import { accessModelRolePermissions } from "../app/lib/access-model-seed.server.ts";

type PreparedAccount = ProductionAccountBlueprint & {
  password: string;
  passwordHash: string;
};

type Options = {
  organizationCode: string;
  sqlPath: string;
  auditSqlPath: string;
  credentialsPath: string;
  fixedPassword?: string;
};

const defaultSecretDirectory = resolve(".local-secrets");

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionsFromArguments(): Options {
  const organizationCode = argumentValue("--organization-code");
  if (!organizationCode) {
    throw new Error("必须显式提供 --organization-code，避免把账号写入错误的组织");
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(organizationCode)) {
    throw new Error("--organization-code 只能包含字母、数字、下划线或连字符，长度为 2-63 位");
  }
  const fixedPassword = argumentValue("--password");
  if (
    fixedPassword &&
    (fixedPassword.length < 12 || !/[a-z]/.test(fixedPassword) || !/[A-Z]/.test(fixedPassword) || !/\d/.test(fixedPassword))
  ) {
    throw new Error("--password 至少 12 位，并同时包含大小写字母和数字");
  }
  return {
    organizationCode,
    sqlPath: resolve(argumentValue("--sql") || `${defaultSecretDirectory}/aliyun-production-accounts.sql`),
    auditSqlPath: resolve(argumentValue("--audit-sql") || `${defaultSecretDirectory}/aliyun-production-access-audit.sql`),
    credentialsPath: resolve(
      argumentValue("--credentials") || `${homedir()}/Desktop/International-TMS-阿里云测试账密.md`,
    ),
    fixedPassword,
  };
}

function generatePassword() {
  return `${randomBytes(18).toString("base64url")}Aa1!`;
}

function hashPassword(password: string) {
  const iterations = 100_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function sqlText(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlList(values: readonly string[]) {
  return values.map(sqlText).join(",");
}

function userIdExpression(email: string) {
  return `(SELECT id FROM users WHERE lower(email)=lower(${sqlText(email)}) LIMIT 1)`;
}

function organizationIdExpression(organizationCode: string) {
  return `(SELECT id FROM organizations WHERE lower(code)=lower(${sqlText(organizationCode)}) LIMIT 1)`;
}

function prepareAccounts(fixedPassword?: string): PreparedAccount[] {
  return productionAccountBlueprint.map((account) => {
    const password = fixedPassword || generatePassword();
    return { ...account, password, passwordHash: hashPassword(password) };
  });
}

function buildProvisionSql(accounts: PreparedAccount[], organizationCode: string, passwordMode: "fixed" | "unique") {
  const now = new Date().toISOString();
  const organizationId = organizationIdExpression(organizationCode);
  const allowedEmails = sqlList(accounts.map((account) => account.email));
  const boss = accounts.find((account) => account.key === "boss");
  if (!boss) throw new Error("Missing boss account blueprint");

  const statements: string[] = [
    `-- Target organization code: ${organizationCode}`,
    `-- Credential password mode: ${passwordMode}`,
    "PRAGMA foreign_keys=ON;",
    "-- Apply only after migrations and /setup have created the target organization and owner.",
    "-- Existing identities outside this allowlist are disabled, not deleted, so audit references remain intact.",
    `DELETE FROM sessions WHERE organization_id=${organizationId};`,
    `UPDATE users SET email=${sqlText(boss.email)},password_hash=${sqlText(boss.passwordHash)},display_name=${sqlText(boss.displayName)},status='active',failed_login_count=0,locked_until=NULL,updated_at=${sqlText(now)}\n` +
      `WHERE id=(SELECT m.user_id FROM memberships m JOIN roles r ON r.organization_id=m.organization_id JOIN membership_roles mr ON mr.membership_id=m.id AND mr.role_id=r.id WHERE m.organization_id=${organizationId} AND r.code='owner' LIMIT 1);`,
  ];

  const assignedRoleCodes = [...new Set(accounts.map((account) => account.roleCode).filter((role): role is string => Boolean(role)))];
  for (const roleCode of assignedRoleCodes.filter((role) => role !== "owner")) {
    const permissions = accessModelRolePermissions[roleCode] ?? [];
    statements.push(
      `DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE organization_id=${organizationId} AND code=${sqlText(roleCode)} LIMIT 1);`,
    );
    if (permissions.length) {
      statements.push(
        `INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (${sqlList(permissions)}) WHERE r.organization_id=${organizationId} AND r.code=${sqlText(roleCode)};`,
      );
    }
  }
  statements.push(
    `INSERT OR IGNORE INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r JOIN permissions p WHERE r.organization_id=${organizationId} AND r.code='owner';`,
  );

  for (const account of accounts.filter((item) => item.key !== "boss")) {
    statements.push(
      `INSERT INTO users(id,email,password_hash,display_name,status,failed_login_count,locked_until,created_at,updated_at)\n` +
      `VALUES(${sqlText(randomUUID())},${sqlText(account.email)},${sqlText(account.passwordHash)},${sqlText(account.displayName)},'active',0,NULL,${sqlText(now)},${sqlText(now)})\n` +
      `ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,display_name=excluded.display_name,status='active',failed_login_count=0,locked_until=NULL,updated_at=excluded.updated_at;`,
    );
  }

  for (const account of accounts.filter((item) => item.site !== "portal")) {
    const departmentId = `(SELECT id FROM departments WHERE organization_id=${organizationId} AND code=${sqlText(account.departmentCode!)} LIMIT 1)`;
    const positionId = `(SELECT id FROM positions WHERE organization_id=${organizationId} AND code=${sqlText(account.positionCode!)} AND status='active' LIMIT 1)`;
    const userId = userIdExpression(account.email);
    statements.push(
      `INSERT INTO memberships(id,organization_id,user_id,title,status,created_at,updated_at,department_id,position_id)\n` +
      `VALUES(${sqlText(randomUUID())},${organizationId},${userId},${sqlText(account.displayName)},'active',${sqlText(now)},${sqlText(now)},${departmentId},${positionId})\n` +
      `ON CONFLICT(organization_id,user_id) DO UPDATE SET title=excluded.title,status='active',department_id=excluded.department_id,position_id=excluded.position_id,updated_at=excluded.updated_at;`,
      `DELETE FROM membership_permission_overrides WHERE membership_id=(SELECT id FROM memberships WHERE organization_id=${organizationId} AND user_id=${userId});`,
      `DELETE FROM membership_roles WHERE membership_id=(SELECT id FROM memberships WHERE organization_id=${organizationId} AND user_id=${userId});`,
      `INSERT INTO membership_roles(membership_id,role_id) SELECT m.id,r.id FROM memberships m JOIN roles r ON r.organization_id=m.organization_id AND r.code=${sqlText(account.roleCode!)} AND r.status='active' WHERE m.organization_id=${organizationId} AND m.user_id=${userId};`,
      `UPDATE customer_portal_accounts SET status='disabled',updated_at=${sqlText(now)} WHERE organization_id=${organizationId} AND user_id=${userId};`,
    );
    if (account.site === "admin") {
      statements.push(`DELETE FROM warehouse_user_access WHERE organization_id=${organizationId} AND user_id=${userId};`);
    }
  }

  const warehouseSeeds = [
    { code: "HRG-01", name: "霍尔果斯普通仓", country: "CN", city: "霍尔果斯市", role: "domestic_collection", zone: "收货暂存区", location: "收货暂存位" },
    { code: "UZ-TAS-01", name: "塔什干目的仓", country: "UZ", city: "塔什干", role: "overseas_destination", zone: "到仓暂存区", location: "到仓暂存位" },
  ] as const;
  for (const warehouse of warehouseSeeds) {
    const warehouseId = randomUUID();
    const zoneId = randomUUID();
    const locationId = randomUUID();
    const currentWarehouseId = `(SELECT id FROM warehouses WHERE organization_id=${organizationId} AND code=${sqlText(warehouse.code)} LIMIT 1)`;
    statements.push(
      `INSERT INTO warehouses(id,organization_id,code,name,country_code,city,address,status,created_at,updated_at,warehouse_role) VALUES(${sqlText(warehouseId)},${organizationId},${sqlText(warehouse.code)},${sqlText(warehouse.name)},${sqlText(warehouse.country)},${sqlText(warehouse.city)},NULL,'active',${sqlText(now)},${sqlText(now)},${sqlText(warehouse.role)}) ON CONFLICT(organization_id,code) DO UPDATE SET name=excluded.name,country_code=excluded.country_code,city=excluded.city,status='active',warehouse_role=excluded.warehouse_role,updated_at=excluded.updated_at;`,
      `INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,zone_type,status,created_at,updated_at) VALUES(${sqlText(zoneId)},${organizationId},${currentWarehouseId},'RCV',${sqlText(warehouse.zone)},'receiving','active',${sqlText(now)},${sqlText(now)}) ON CONFLICT(warehouse_id,code) DO UPDATE SET name=excluded.name,zone_type='receiving',status='active',updated_at=excluded.updated_at;`,
      `INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,barcode,status,created_at,updated_at) VALUES(${sqlText(locationId)},${organizationId},${currentWarehouseId},(SELECT id FROM warehouse_zones WHERE warehouse_id=${currentWarehouseId} AND code='RCV' LIMIT 1),'RCV-01',${sqlText(warehouse.location)},${sqlText(`${warehouse.code}-RCV-01`)},'active',${sqlText(now)},${sqlText(now)}) ON CONFLICT(warehouse_id,code) DO UPDATE SET name=excluded.name,barcode=excluded.barcode,status='active',updated_at=excluded.updated_at;`,
    );
  }

  for (const account of accounts.filter((item) => item.site === "warehouse")) {
    const userId = userIdExpression(account.email);
    const warehouseCode = account.warehouseRole === "overseas_destination" ? "UZ-TAS-01" : "HRG-01";
    statements.push(
      `DELETE FROM warehouse_user_access WHERE organization_id=${organizationId} AND user_id=${userId};`,
      `INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,granted_by_user_id,created_at,updated_at) VALUES(${sqlText(randomUUID())},${organizationId},(SELECT id FROM warehouses WHERE organization_id=${organizationId} AND code=${sqlText(warehouseCode)} LIMIT 1),${userId},'manager',(SELECT m.user_id FROM memberships m JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id WHERE m.organization_id=${organizationId} AND r.code='owner' LIMIT 1),${sqlText(now)},${sqlText(now)});`,
    );
  }

  const salesUserId = userIdExpression("sales@e2e.test");
  for (const account of accounts.filter((item) => item.site === "portal")) {
    const number = account.customerNumber!;
    const userId = userIdExpression(account.email);
    const customerCode = `TEST-CUSTOMER-${number}`;
    const identityCode = `T${number + 1}A${number + 1}B`;
    const customerId = randomUUID();
    statements.push(
      `INSERT INTO customers(id,organization_id,code,name,short_name,type,sales_owner_user_id,status,created_at,updated_at,identity_code) VALUES(${sqlText(customerId)},${organizationId},${sqlText(customerCode)},${sqlText(`测试客户${number}`)},${sqlText(`客户${number}`)},'direct',${salesUserId},'active',${sqlText(now)},${sqlText(now)},${sqlText(identityCode)}) ON CONFLICT(organization_id,code) DO UPDATE SET name=excluded.name,short_name=excluded.short_name,sales_owner_user_id=excluded.sales_owner_user_id,status='active',updated_at=excluded.updated_at;`,
      `INSERT INTO customer_portal_accounts(id,organization_id,customer_id,user_id,status,created_at,updated_at) VALUES(${sqlText(randomUUID())},${organizationId},(SELECT id FROM customers WHERE organization_id=${organizationId} AND code=${sqlText(customerCode)} LIMIT 1),${userId},'active',${sqlText(now)},${sqlText(now)}) ON CONFLICT(organization_id,user_id) DO UPDATE SET customer_id=excluded.customer_id,status='active',updated_at=excluded.updated_at;`,
      `UPDATE memberships SET status='disabled',updated_at=${sqlText(now)} WHERE organization_id=${organizationId} AND user_id=${userId};`,
      `DELETE FROM warehouse_user_access WHERE organization_id=${organizationId} AND user_id=${userId};`,
    );
  }

  statements.push(
    `UPDATE users SET status='disabled',updated_at=${sqlText(now)} WHERE lower(email) NOT IN (${allowedEmails}) AND id IN (SELECT user_id FROM memberships WHERE organization_id=${organizationId} UNION SELECT user_id FROM customer_portal_accounts WHERE organization_id=${organizationId} UNION SELECT user_id FROM warehouse_user_access WHERE organization_id=${organizationId});`,
    `UPDATE memberships SET status='disabled',updated_at=${sqlText(now)} WHERE organization_id=${organizationId} AND user_id NOT IN (SELECT id FROM users WHERE lower(email) IN (${allowedEmails}));`,
    `UPDATE customer_portal_accounts SET status='disabled',updated_at=${sqlText(now)} WHERE organization_id=${organizationId} AND user_id NOT IN (SELECT id FROM users WHERE lower(email) IN (${allowedEmails}));`,
    `DELETE FROM warehouse_user_access WHERE organization_id=${organizationId} AND user_id NOT IN (SELECT id FROM users WHERE lower(email) IN (${allowedEmails}));`,
    `DELETE FROM sessions WHERE organization_id=${organizationId};`,
    "-- End of audit-safe account provisioning.",
  );
  return `${statements.join("\n\n")}\n`;
}

function buildAuditSql(accounts: PreparedAccount[], organizationCode: string) {
  const organizationId = organizationIdExpression(organizationCode);
  const allowedEmails = sqlList(accounts.map((account) => account.email));
  const membershipAccounts = accounts.filter((account) => account.site !== "portal");
  const rolePermissionPairs = membershipAccounts
    .filter((account) => account.roleCode && account.roleCode !== "owner")
    .flatMap((account) => (accessModelRolePermissions[account.roleCode!] ?? []).map((permission) => [account.roleCode!, permission] as const));
  const assignedNonOwnerRoles = [...new Set(membershipAccounts.map((account) => account.roleCode).filter((role): role is string => Boolean(role) && role !== "owner"))];
  return `-- Expected result: every finding query returns zero rows. The final query is the readable account matrix.\n` +
    `SELECT 'unexpected_active_identity' finding,u.email FROM users u WHERE u.status='active' AND lower(u.email) NOT IN (${allowedEmails}) AND u.id IN (SELECT user_id FROM memberships WHERE organization_id=${organizationId} AND status='active' UNION SELECT user_id FROM customer_portal_accounts WHERE organization_id=${organizationId} AND status='active' UNION SELECT user_id FROM warehouse_user_access WHERE organization_id=${organizationId});\n\n` +
    `WITH expected(email) AS (VALUES ${accounts.map((account) => `(${sqlText(account.email)})`).join(",")}) SELECT 'missing_or_disabled_expected_identity' finding,expected.email FROM expected LEFT JOIN users u ON lower(u.email)=lower(expected.email) WHERE u.id IS NULL OR u.status!='active';\n\n` +
    `WITH expected(email,department_code,position_code,role_code) AS (VALUES ${membershipAccounts.map((account) => `(${sqlText(account.email)},${sqlText(account.departmentCode!)},${sqlText(account.positionCode!)},${sqlText(account.roleCode!)})`).join(",")}) SELECT 'membership_assignment_mismatch' finding,expected.email,expected.department_code,expected.position_code,expected.role_code FROM expected LEFT JOIN users u ON lower(u.email)=lower(expected.email) LEFT JOIN memberships m ON m.user_id=u.id AND m.organization_id=${organizationId} AND m.status='active' LEFT JOIN departments d ON d.id=m.department_id LEFT JOIN positions p ON p.id=m.position_id LEFT JOIN membership_roles mr ON mr.membership_id=m.id LEFT JOIN roles r ON r.id=mr.role_id WHERE m.id IS NULL OR d.code!=expected.department_code OR p.code!=expected.position_code OR r.code!=expected.role_code GROUP BY expected.email;\n\n` +
    `SELECT 'admin_account_has_warehouse_binding' finding,u.email FROM users u JOIN warehouse_user_access a ON a.user_id=u.id WHERE a.organization_id=${organizationId} AND lower(u.email) IN (${sqlList(accounts.filter((account) => account.site === "admin").map((account) => account.email))});\n\n` +
    `SELECT 'warehouse_account_has_office_role' finding,u.email,r.code FROM users u JOIN memberships m ON m.user_id=u.id AND m.organization_id=${organizationId} JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id WHERE lower(u.email) IN (${sqlList(accounts.filter((account) => account.site === "warehouse").map((account) => account.email))}) AND r.code NOT IN ('warehouse_operator','overseas_warehouse_operator');\n\n` +
    `WITH expected(email,warehouse_role) AS (VALUES ${accounts.filter((account) => account.site === "warehouse").map((account) => `(${sqlText(account.email)},${sqlText(account.warehouseRole!)})`).join(",")}) SELECT 'warehouse_binding_mismatch' finding,expected.email,expected.warehouse_role,COUNT(a.id) binding_count FROM expected LEFT JOIN users u ON lower(u.email)=lower(expected.email) LEFT JOIN warehouse_user_access a ON a.user_id=u.id AND a.organization_id=${organizationId} LEFT JOIN warehouses w ON w.id=a.warehouse_id AND w.warehouse_role=expected.warehouse_role WHERE w.id IS NULL GROUP BY expected.email HAVING COUNT(a.id)!=1 OR COUNT(w.id)!=1;\n\n` +
    `SELECT 'portal_account_has_active_membership' finding,u.email FROM users u JOIN memberships m ON m.user_id=u.id AND m.organization_id=${organizationId} AND m.status='active' WHERE lower(u.email) IN (${sqlList(accounts.filter((account) => account.site === "portal").map((account) => account.email))});\n\n` +
    `WITH expected(role_code,permission_code) AS (VALUES ${rolePermissionPairs.map(([role, permission]) => `(${sqlText(role)},${sqlText(permission)})`).join(",")}) SELECT 'missing_role_permission' finding,expected.role_code,expected.permission_code FROM expected LEFT JOIN roles r ON r.organization_id=${organizationId} AND r.code=expected.role_code LEFT JOIN role_permissions rp ON rp.role_id=r.id AND rp.permission_code=expected.permission_code WHERE rp.permission_code IS NULL;\n\n` +
    `WITH expected(role_code,permission_code) AS (VALUES ${rolePermissionPairs.map(([role, permission]) => `(${sqlText(role)},${sqlText(permission)})`).join(",")}) SELECT 'unexpected_role_permission' finding,r.code,rp.permission_code FROM roles r JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN expected ON expected.role_code=r.code AND expected.permission_code=rp.permission_code WHERE r.organization_id=${organizationId} AND r.code IN (${sqlList(assignedNonOwnerRoles)}) AND expected.permission_code IS NULL;\n\n` +
    `SELECT 'owner_missing_permission' finding,p.code FROM permissions p WHERE NOT EXISTS(SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id=r.id WHERE r.organization_id=${organizationId} AND r.code='owner' AND rp.permission_code=p.code);\n\n` +
    `SELECT u.email,m.status membership_status,d.name department,p.name position,GROUP_CONCAT(r.code) roles FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.organization_id=${organizationId} LEFT JOIN departments d ON d.id=m.department_id LEFT JOIN positions p ON p.id=m.position_id LEFT JOIN membership_roles mr ON mr.membership_id=m.id LEFT JOIN roles r ON r.id=mr.role_id WHERE lower(u.email) IN (${allowedEmails}) GROUP BY u.id,m.id ORDER BY u.email;\n`;
}

function accountNote(account: PreparedAccount) {
  if (account.site === "portal") return `仅客户门户；绑定测试客户${account.customerNumber}`;
  if (account.site === "warehouse") return account.warehouseRole === "overseas_destination" ? "仅境外仓库门户" : "仅国内仓库门户";
  if (["pos_business_route", "pos_front_loading"].includes(account.roleCode || "")) return "管理后台；当前仅岗位/薪资归类，无业务数据权限";
  return "管理后台；按岗位权限与订单范围显示";
}

function buildCredentialsMarkdown(accounts: PreparedAccount[], organizationCode: string, passwordMode: "fixed" | "unique") {
  const lines = [
    "# International TMS 阿里云测试账密",
    "",
    `- 生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `- 目标组织代码：${organizationCode}`,
    "- 管理后台入口：`/login`",
    "- 客户门户入口：`/portal/login`",
    "- 仓库端入口：`/warehouse/login`",
    passwordMode === "fixed"
      ? "- 说明：本地与阿里云测试环境使用统一测试密码；不要把本文件提交到 Git 或发到公开群聊。"
      : "- 说明：每个账号使用独立随机强密码；不要把本文件提交到 Git 或发到公开群聊。",
    "",
    "| 端 | 部门 | 岗位/客户 | 登录邮箱 | 密码 | 权限说明 |",
    "|---|---|---|---|---|---|",
  ];
  for (const account of accounts) {
    const site = account.site === "admin" ? "管理后台" : account.site === "warehouse" ? "仓库端" : "客户门户";
    lines.push(`| ${site} | ${account.departmentCode || "—"} | ${account.displayName} | \`${account.email}\` | \`${account.password}\` | ${accountNote(account)} |`);
  }
  lines.push("", "## 数量核对", "", "- 管理后台：11 个账号（每个办公室岗位 1 个）", "- 仓库端：2 个账号（国内仓、境外仓各 1 个）", "- 客户门户：3 个账号（测试客户 1–3）", "- 合计：16 个可登录账号", "");
  return lines.join("\n");
}

export function prepareProductionAccountArtifacts(options: Options) {
  const accounts = prepareAccounts(options.fixedPassword);
  const passwordMode = options.fixedPassword ? "fixed" : "unique";
  for (const path of [options.sqlPath, options.auditSqlPath, options.credentialsPath]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(options.sqlPath, buildProvisionSql(accounts, options.organizationCode, passwordMode), { encoding: "utf8", mode: 0o600 });
  writeFileSync(options.auditSqlPath, buildAuditSql(accounts, options.organizationCode), { encoding: "utf8", mode: 0o600 });
  writeFileSync(options.credentialsPath, `\uFEFF${buildCredentialsMarkdown(accounts, options.organizationCode, passwordMode)}`, { encoding: "utf8", mode: 0o600 });
  return options;
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (launchedDirectly) {
  const output = prepareProductionAccountArtifacts(optionsFromArguments());
  console.log(`Provision SQL: ${output.sqlPath}`);
  console.log(`Audit SQL: ${output.auditSqlPath}`);
  console.log(`Credentials: ${output.credentialsPath}`);
}
