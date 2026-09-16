import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/portal.register";
import { getSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { hashPassword } from "../lib/crypto.server";
import { broadcastInternalNotification } from "../lib/internal-notifications.server";
import {
  validatePortalRegistration,
  type PortalRegistrationInput,
} from "../lib/portal-registration";
import {
  PORTAL_CONTEXT_PARAM,
  normalizePortalContextId,
  portalContextIdFromRequest,
  portalContextualPath,
} from "../lib/portal-session-context";
import { siteFromRequest, siteLogin } from "../lib/site.server";
import { valueOf } from "../lib/validation";

export function meta() { return [{ title: "注册客户门户账号 | International TMS" }]; }

export async function loader({ request }: Route.LoaderArgs) {
  const site = siteFromRequest(request);
  if (site !== "portal") throw redirect(siteLogin(site));
  const contextId = portalContextIdFromRequest(request) || crypto.randomUUID();
  if ((await getSessionUser(request, "portal", null, contextId))?.site === "portal")
    throw redirect(portalContextualPath("/portal", contextId));
  return { contextId };
}

export async function action({ request }: Route.ActionArgs) {
  const site = siteFromRequest(request);
  if (site !== "portal") throw redirect(siteLogin(site));
  const form = await request.formData();
  const contextId = normalizePortalContextId(valueOf(form, PORTAL_CONTEXT_PARAM)) || crypto.randomUUID();
  const input: PortalRegistrationInput = {
    companyName: valueOf(form, "companyName"),
    customerIdentityCode: valueOf(form, "customerIdentityCode").toUpperCase(),
    displayName: valueOf(form, "displayName"),
    email: valueOf(form, "email").toLowerCase(),
    phone: valueOf(form, "phone"),
    password: valueOf(form, "password"),
    confirmPassword: valueOf(form, "confirmPassword"),
    acceptedTerms: valueOf(form, "acceptedTerms") === "1",
  };
  const values = {
    companyName: input.companyName,
    customerIdentityCode: input.customerIdentityCode,
    displayName: input.displayName,
    email: input.email,
    phone: input.phone,
  };
  const fieldErrors = validatePortalRegistration(input);
  if (Object.keys(fieldErrors).length) return { fieldErrors, values, contextId };

  const organization = await env.DB.prepare(
    "SELECT id,name FROM organizations WHERE status='active' ORDER BY created_at LIMIT 1",
  ).first<{ id: string; name: string }>();
  if (!organization) return { formError: "客户门户暂未开放注册，请联系业务人员。", values, contextId };

  const existingUser = await env.DB.prepare(
    `SELECT u.id,cpa.status portal_status,pr.status registration_status
       FROM users u
       LEFT JOIN customer_portal_accounts cpa ON cpa.user_id=u.id AND cpa.organization_id=?
       LEFT JOIN portal_registration_requests pr ON pr.user_id=u.id AND pr.organization_id=?
      WHERE u.email=? LIMIT 1`,
  ).bind(organization.id, organization.id, input.email).first<{
    id: string;
    portal_status: string | null;
    registration_status: string | null;
  }>();
  if (existingUser) {
    const message = existingUser.portal_status === "active"
      ? "该邮箱已经开通客户门户，请直接返回登录。"
      : existingUser.registration_status === "pending"
        ? "该邮箱的注册申请正在审核中，请勿重复提交。"
        : "该邮箱已存在账号或历史申请，请联系业务人员处理。";
    return { fieldErrors: { email: message }, values, contextId };
  }

  const candidate = input.customerIdentityCode
    ? await env.DB.prepare(
      `SELECT id FROM customers
       WHERE organization_id=? AND identity_code=? AND status IN ('prospect','active','suspended') LIMIT 1`,
    ).bind(organization.id, input.customerIdentityCode).first<{ id: string }>()
    : null;
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users(id,email,password_hash,display_name,phone,status,created_at,updated_at)
         VALUES(?,?,?,?,?,'active',?,?)`,
      ).bind(userId, input.email, await hashPassword(input.password), input.displayName, input.phone || null, now, now),
      env.DB.prepare(
        `INSERT INTO portal_registration_requests(
          id,organization_id,user_id,candidate_customer_id,company_name,customer_identity_code,
          contact_name,contact_phone,email,status,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      ).bind(
        requestId, organization.id, userId, candidate?.id ?? null, input.companyName,
        input.customerIdentityCode || null, input.displayName, input.phone || null, input.email, now, now,
      ),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) {
      return { fieldErrors: { email: "该邮箱已存在账号或注册申请，请返回登录或联系业务人员。" }, values, contextId };
    }
    throw error;
  }
  await writeAudit({
    request,
    action: "portal.registration.submit",
    resourceType: "portal_registration_request",
    resourceId: requestId,
    organizationId: organization.id,
    actorUserId: userId,
    metadata: { companyName: input.companyName, email: input.email, candidateCustomerId: candidate?.id ?? null },
  });
  await broadcastInternalNotification({
    organizationId: organization.id,
    actorUserId: userId,
    category: "portal_registration",
    severity: "info",
    title: "新的客户门户注册申请",
    message: `${input.companyName} · ${input.displayName}（${input.email}）申请开通客户门户，请确认绑定客户。`,
    link: "/admin/customers#portal-registration-requests",
  });
  return {
    success: "注册申请已提交",
    email: input.email,
    companyName: input.companyName,
    matched: Boolean(candidate),
    contextId,
  };
}

export default function PortalRegister({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const contextId = actionData?.contextId || loaderData.contextId;
  const loginHref = portalContextualPath("/portal/login", contextId);
  if (actionData && "success" in actionData && actionData.success) return <main className="auth-page portal-auth portal-register-page">
    <section className="auth-card wide portal-register-card portal-registration-complete">
      <div className="brand-mark portal-mark">OT</div><p className="eyebrow">REGISTRATION SUBMITTED</p><h1>{actionData.success}</h1>
      <p className="muted">后台将把账号绑定到正确的客户档案；绑定完成后即可使用注册邮箱和密码登录。</p>
      <ol className="portal-registration-steps" aria-label="注册进度">
        <li className="complete"><span>1</span><div><strong>提交注册资料</strong><small>{actionData.companyName}</small></div></li>
        <li className="current"><span>2</span><div><strong>后台确认客户</strong><small>{actionData.matched ? "已预匹配客户，等待确认" : "等待业务人员选择客户"}</small></div></li>
        <li><span>3</span><div><strong>开放客户门户</strong><small>审核通过后即可登录</small></div></li>
      </ol>
      <div className="alert success" role="status">申请邮箱：<strong>{actionData.email}</strong>。请妥善保管刚才设置的密码。</div>
      <Link className="primary portal-primary portal-register-login" to={loginHref}>返回客户门户登录</Link>
    </section>
  </main>;

  const values = actionData && "values" in actionData ? actionData.values : undefined;
  const errors = actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  const formError = actionData && "formError" in actionData ? actionData.formError : undefined;
  const fieldError = (name: keyof NonNullable<typeof errors>) => errors?.[name];
  return <main className="auth-page portal-auth portal-register-page"><section className="auth-card wide portal-register-card">
    <div className="portal-register-heading"><div><div className="brand-mark portal-mark">OT</div><p className="eyebrow">OULING CUSTOMER PORTAL</p><h1>注册客户门户账号</h1><p className="muted">提交后由后台确认并绑定客户档案，避免账号看到错误的订单和账单。</p></div><Link className="site-switch" to={loginHref}>已有账号，返回登录 →</Link></div>
    {formError && <div className="alert error" role="alert">{formError}</div>}
    <Form method="post" className="portal-register-form">
      <input type="hidden" name={PORTAL_CONTEXT_PARAM} value={contextId}/>
      <section><h2>企业与联系人</h2><p>客户识别码可在报价单、订单或业务人员提供的资料中查看；没有识别码也可以提交。</p>
        <div className="portal-register-grid">
          <label className="field field-wide"><span>企业全称 *</span><input name="companyName" defaultValue={values?.companyName} required minLength={2} maxLength={160} autoFocus aria-invalid={Boolean(fieldError("companyName"))}/>{fieldError("companyName")&&<small className="field-error" role="alert">{fieldError("companyName")}</small>}</label>
          <label className="field"><span>客户识别码</span><input name="customerIdentityCode" defaultValue={values?.customerIdentityCode} maxLength={5} autoCapitalize="characters" placeholder="例如 A2B3C" aria-invalid={Boolean(fieldError("customerIdentityCode"))}/>{fieldError("customerIdentityCode")?<small className="field-error" role="alert">{fieldError("customerIdentityCode")}</small>:<small>选填，用于后台预匹配客户</small>}</label>
          <label className="field"><span>联系人姓名 *</span><input name="displayName" defaultValue={values?.displayName} required minLength={2} maxLength={80} autoComplete="name" aria-invalid={Boolean(fieldError("displayName"))}/>{fieldError("displayName")&&<small className="field-error" role="alert">{fieldError("displayName")}</small>}</label>
          <label className="field"><span>联系电话 *</span><input name="phone" defaultValue={values?.phone} type="tel" inputMode="tel" maxLength={30} autoComplete="tel" required aria-invalid={Boolean(fieldError("phone"))}/>{fieldError("phone")&&<small className="field-error" role="alert">{fieldError("phone")}</small>}</label>
        </div>
      </section>
      <section><h2>登录资料</h2><p>邮箱将作为登录账号；密码至少 12 位，并包含大小写字母和数字。</p>
        <div className="portal-register-grid">
          <label className="field field-wide"><span>登录邮箱 *</span><input name="email" defaultValue={values?.email} type="email" required maxLength={254} autoComplete="email" aria-invalid={Boolean(fieldError("email"))}/>{fieldError("email")&&<small className="field-error" role="alert">{fieldError("email")}</small>}</label>
          <label className="field"><span>设置密码 *</span><input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" aria-invalid={Boolean(fieldError("password"))}/>{fieldError("password")&&<small className="field-error" role="alert">{fieldError("password")}</small>}</label>
          <label className="field"><span>确认密码 *</span><input name="confirmPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" aria-invalid={Boolean(fieldError("confirmPassword"))}/>{fieldError("confirmPassword")&&<small className="field-error" role="alert">{fieldError("confirmPassword")}</small>}</label>
        </div>
      </section>
      <label className="check-field portal-register-agreement"><input name="acceptedTerms" value="1" type="checkbox" required/>我确认以上资料真实，并同意由后台审核后绑定到对应客户档案。{fieldError("acceptedTerms")&&<small className="field-error" role="alert">{fieldError("acceptedTerms")}</small>}</label>
      <div className="portal-register-actions"><span>提交后不会立即开放数据，必须完成客户绑定审核。</span><button className="primary portal-primary" disabled={busy}>{busy ? "正在提交…" : "提交注册申请"}</button></div>
    </Form>
  </section></main>;
}
