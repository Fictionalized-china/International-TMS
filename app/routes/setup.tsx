import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/setup";
import { createSession } from "../lib/auth.server";
import { hashPassword, secureEqual } from "../lib/crypto.server";
import {
  validateCode,
  validateEmail,
  validatePassword,
  valueOf,
  type FieldErrors,
} from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { accessModelBootstrapStatements } from "../lib/access-model-seed.server";

export function meta() {
  return [{ title: "初始化 | International TMS" }];
}

export async function loader() {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users",
  ).first<{ count: number }>();
  if (row?.count) throw redirect("/login");
  return { ready: Boolean(env.BOOTSTRAP_TOKEN) };
}

export async function action({ request }: Route.ActionArgs) {
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users",
  ).first<{ count: number }>();
  if (existing?.count) throw new Response("系统已经初始化", { status: 409 });
  if (!env.BOOTSTRAP_TOKEN)
    return {
      formError: "服务器尚未配置 BOOTSTRAP_TOKEN",
      errors: {} as FieldErrors,
    };

  const form = await request.formData();
  const organizationName = valueOf(form, "organizationName");
  const organizationCode = valueOf(form, "organizationCode").toLowerCase();
  const displayName = valueOf(form, "displayName");
  const email = valueOf(form, "email").toLowerCase();
  const password = valueOf(form, "password");
  const bootstrapToken = valueOf(form, "bootstrapToken");
  const errors: FieldErrors = {};
  if (organizationName.length < 2 || organizationName.length > 100)
    errors.organizationName = "组织名称需要 2-100 个字符";
  const codeError = validateCode(organizationCode);
  if (codeError) errors.organizationCode = codeError;
  if (displayName.length < 2 || displayName.length > 80)
    errors.displayName = "姓名需要 2-80 个字符";
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;
  const passwordError = validatePassword(password);
  if (passwordError) errors.password = passwordError;
  if (!(await secureEqual(bootstrapToken, env.BOOTSTRAP_TOKEN)))
    errors.bootstrapToken = "初始化令牌不正确";
  if (Object.keys(errors).length)
    return {
      errors,
      values: { organizationName, organizationCode, displayName, email },
    };

  const now = new Date().toISOString();
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const roleId = crypto.randomUUID();
  const referenceSeeds = [
    ["country", "CN", "中国", "China", 10],
    ["country", "US", "美国", "United States", 20],
    ["country", "UZ", "乌兹别克斯坦", "Uzbekistan", 30],
    ["currency", "CNY", "人民币", "Chinese Yuan", 10],
    ["currency", "USD", "美元", "US Dollar", 20],
    ["unit", "KG", "千克", "Kilogram", 10],
    ["unit", "CBM", "立方米", "Cubic Meter", 20],
    ["transport_mode", "ROAD", "公路零担", "Road LTL", 10],
    ["service_level", "STANDARD", "标准服务", "Standard", 10],
    ["lead_source", "REFERRAL", "客户转介绍", "Referral", 10],
  ] as const;
  const geographicSeeds = [
    ["province", "CN-XJ", "新疆维吾尔自治区", "Xinjiang", "CN", 10],
    ["province", "CN-GD", "广东省", "Guangdong", "CN", 20],
    ["province", "CN-HN", "湖南省", "Hunan", "CN", 30],
    ["province", "UZ-TK", "塔什干市", "Tashkent City", "UZ", 10],
    ["city", "CN-XJ-URC", "乌鲁木齐市", "Urumqi", "CN-XJ", 10],
    ["city", "CN-GD-SZX", "深圳市", "Shenzhen", "CN-GD", 10],
    ["city", "CN-HN-CSX", "长沙市", "Changsha", "CN-HN", 10],
    ["city", "UZ-TK-TAS", "塔什干", "Tashkent", "UZ-TK", 10],
  ] as const;
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    return bootstrapFailure("PASSWORD_HASH", error);
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organizations (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(organizationId, organizationCode, organizationName, now, now),
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(userId, email, passwordHash, displayName, now, now),
      env.DB.prepare(
        "INSERT INTO memberships (id, organization_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(membershipId, organizationId, userId, "系统管理员", now, now),
      env.DB.prepare(
        "INSERT INTO roles (id, organization_id, code, name, description, is_system, created_at, updated_at) VALUES (?, ?, 'owner', '所有者', '拥有当前组织全部权限', 1, ?, ?)",
      ).bind(roleId, organizationId, now, now),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_code) SELECT ?, code FROM permissions",
      ).bind(roleId),
      env.DB.prepare(
        "INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
      ).bind(membershipId, roleId),
      ...referenceSeeds.map(([category, code, name, nameEn, sortOrder]) =>
        env.DB.prepare(
          "INSERT INTO reference_data (id, organization_id, category, code, name, name_en, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          crypto.randomUUID(),
          organizationId,
          category,
          code,
          name,
          nameEn,
          sortOrder,
          now,
          now,
        ),
      ),
      ...geographicSeeds.map(
        ([category, code, name, nameEn, parentCode, sortOrder]) =>
          env.DB.prepare(
            "INSERT INTO reference_data (id, organization_id, category, code, name, name_en, parent_code, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            crypto.randomUUID(),
            organizationId,
            category,
            code,
            name,
            nameEn,
            parentCode,
            sortOrder,
            now,
            now,
          ),
      ),
      ...accessModelBootstrapStatements(env.DB, organizationId, userId, now),
    ]);
  } catch (error) {
    return bootstrapFailure("DATABASE_BATCH", error);
  }

  try {
    await writeAudit({
      request,
      action: "system.bootstrap",
      resourceType: "organization",
      resourceId: organizationId,
      organizationId,
      actorUserId: userId,
    });
  } catch (error) {
    return bootstrapFailure("AUDIT_LOG", error);
  }

  try {
    return redirect("/dashboard", {
      headers: { "Set-Cookie": await createSession(userId, organizationId) },
    });
  } catch (error) {
    return bootstrapFailure("SESSION", error);
  }
}

function bootstrapFailure(stage: string, error: unknown) {
  const incidentId = crypto.randomUUID();
  console.error("System bootstrap failed", { incidentId, stage, error });
  return {
    formError: `初始化失败（${stage}，参考编号：${incidentId}）`,
    errors: {} as FieldErrors,
  };
}

export default function Setup({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <main className="auth-page">
      <section className="auth-card wide">
        <div className="brand-mark">IT</div>
        <p className="eyebrow">FIRST RUN</p>
        <h1>初始化 International TMS</h1>
        <p className="muted">
          创建第一个组织和系统所有者。初始化完成后此页面会自动关闭。
        </p>
        {!loaderData.ready && (
          <div className="alert error">
            请先在本地 `.dev.vars` 中配置 BOOTSTRAP_TOKEN。
          </div>
        )}
        {actionData?.formError && (
          <div className="alert error">{actionData.formError}</div>
        )}
        <Form method="post" className="form-grid">
          <Field
            label="组织名称"
            name="organizationName"
            defaultValue={actionData?.values?.organizationName}
            error={actionData?.errors?.organizationName}
          />
          <Field
            label="组织代码"
            name="organizationCode"
            placeholder="ouling"
            defaultValue={actionData?.values?.organizationCode}
            error={actionData?.errors?.organizationCode}
          />
          <Field
            label="管理员姓名"
            name="displayName"
            defaultValue={actionData?.values?.displayName}
            error={actionData?.errors?.displayName}
          />
          <Field
            label="管理员邮箱"
            name="email"
            type="email"
            defaultValue={actionData?.values?.email}
            error={actionData?.errors?.email}
          />
          <Field
            label="管理员密码"
            name="password"
            type="password"
            error={actionData?.errors?.password}
            hint="至少 12 位，包含大小写字母和数字"
          />
          <Field
            label="一次性初始化令牌"
            name="bootstrapToken"
            type="password"
            error={actionData?.errors?.bootstrapToken}
          />
          <button
            className="primary span-2"
            disabled={busy || !loaderData.ready}
          >
            {busy ? "正在初始化…" : "创建系统"}
          </button>
        </Form>
      </section>
    </main>
  );
}

function Field({
  label,
  name,
  error,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  error?: string;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} required {...props} />
      {error ? (
        <small className="field-error">{error}</small>
      ) : hint ? (
        <small>{hint}</small>
      ) : null}
    </label>
  );
}
