import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import { randomToken, sha256 } from "./crypto.server";
import type { Site } from "./site.server";
import { siteFromRequest, siteLogin } from "./site.server";

const SITE_COOKIE_NAMES: Record<Exclude<Site, "warehouse">, string> = {
  admin: "itms_admin_session",
  portal: "itms_portal_session",
};

export type SessionUser = {
  sessionId: string;
  userId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  displayName: string;
  site: Site;
  permissions: string[];
  positionCode: string | null;
  roleCodes: string[];
};

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function warehouseIdFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).searchParams.get("warehouseId");
  } catch {
    return null;
  }
}

export function warehouseIdFromRequest(request: Request): string | null {
  return (
    new URL(request.url).searchParams.get("warehouseId") ||
    warehouseIdFromUrl(request.headers.get("Referer"))
  );
}

function cookieName(site: Site, warehouseId?: string | null): string {
  if (site !== "warehouse") return SITE_COOKIE_NAMES[site];
  if (!warehouseId) return "itms_warehouse_session";
  return `itms_warehouse_session_${warehouseId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export async function createSession(
  userId: string,
  organizationId: string,
  site: Site = "admin",
  warehouseId?: string | null,
): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date();
  const ttl = Math.max(900, Number(env.SESSION_TTL_SECONDS || 28_800));
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, organization_id, token_hash, expires_at, last_seen_at, created_at, site)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, organizationId, tokenHash, expiresAt.toISOString(), now.toISOString(), now.toISOString(), site)
    .run();
  return `${cookieName(site, warehouseId)}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;
}

export async function getSessionUser(
  request: Request,
  site: Site = siteFromRequest(request),
  warehouseId?: string | null,
): Promise<SessionUser | null> {
  const resolvedWarehouseId = site === "warehouse"
    ? warehouseId || warehouseIdFromRequest(request)
    : null;
  const token = cookieValue(request, cookieName(site, resolvedWarehouseId));
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.site, u.id AS user_id, u.email, u.display_name,
            o.id AS organization_id, o.name AS organization_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = s.organization_id
      WHERE s.token_hash = ? AND s.expires_at > ?
        AND u.status = 'active' AND o.status = 'active'
        AND (
          (s.site = 'admin' AND EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.user_id = u.id AND m.organization_id = o.id AND m.status = 'active'
          ))
          OR
          (s.site = 'portal' AND EXISTS (
            SELECT 1 FROM customer_portal_accounts cpa
            WHERE cpa.user_id = u.id AND cpa.organization_id = o.id AND cpa.status = 'active'
          ))
          OR
          (s.site = 'warehouse' AND EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id=m.id
            JOIN role_permissions rp ON rp.role_id=mr.role_id AND rp.permission_code='warehouse.view'
            WHERE m.user_id=u.id AND m.organization_id=o.id AND m.status='active'
          ))
        )`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<Record<string, string>>();
  if (!row || row.site !== site) return null;
  const [permissionRows, accessProfile] = await Promise.all([
    env.DB.prepare(
    `SELECT DISTINCT rp.permission_code AS code
       FROM memberships m
       JOIN membership_roles mr ON mr.membership_id = m.id
       JOIN roles r ON r.id = mr.role_id AND r.organization_id = m.organization_id
       JOIN role_permissions rp ON rp.role_id = r.id
      WHERE m.user_id = ? AND m.organization_id = ? AND m.status = 'active'`,
  )
    .bind(row.user_id, row.organization_id)
    .all<{ code: string }>(),
    env.DB.prepare(
      `SELECT p.code position_code,GROUP_CONCAT(DISTINCT r.code) role_codes
       FROM memberships m
       LEFT JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
       LEFT JOIN membership_roles mr ON mr.membership_id=m.id
       LEFT JOIN roles r ON r.id=mr.role_id AND r.organization_id=m.organization_id
       WHERE m.user_id=? AND m.organization_id=? AND m.status='active'
       GROUP BY m.id
       LIMIT 1`,
    )
      .bind(row.user_id, row.organization_id)
      .first<{ position_code: string | null; role_codes: string | null }>(),
  ]);
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    displayName: row.display_name,
    site: row.site as Site,
    permissions: permissionRows.results.map((item) => item.code),
    positionCode: accessProfile?.position_code ?? null,
    roleCodes: (accessProfile?.role_codes ?? "").split(",").filter(Boolean),
  };
}

export function canEditWorkflowDefinition(user: SessionUser) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => ["boss", "developer", "owner"].includes(code))
  );
}

export async function requireSessionUser(request: Request, permission?: string, site: Site = "admin"): Promise<SessionUser> {
  const user = await getSessionUser(request, site);
  const requestedSite=siteFromRequest(request);
  if (requestedSite!==site) throw redirect(siteLogin(requestedSite));
  if (!user || user.site !== site) throw redirect(siteLogin(site));
  if (permission && !user.permissions.includes(permission)) throw new Response("没有权限执行此操作", { status: 403 });
  return user;
}

export async function destroySession(
  request: Request,
  site: Site = siteFromRequest(request),
  warehouseId?: string | null,
): Promise<string> {
  const resolvedWarehouseId = site === "warehouse"
    ? warehouseId || warehouseIdFromRequest(request)
    : null;
  const name = cookieName(site, resolvedWarehouseId);
  const token = cookieValue(request, name);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function isLoginLocked(lockedUntil: string | null | undefined): boolean {
  return Boolean(lockedUntil && new Date(lockedUntil).getTime() > Date.now());
}

export async function recordLoginFailure(userId: string, currentFailures: number): Promise<void> {
  const nextFailures = currentFailures + 1;
  const lockedUntil = nextFailures >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
  await env.DB.prepare("UPDATE users SET failed_login_count = ?, locked_until = COALESCE(?, locked_until), updated_at = ? WHERE id = ?")
    .bind(nextFailures, lockedUntil, new Date().toISOString(), userId)
    .run();
}

export async function clearLoginFailures(userId: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), new Date().toISOString(), userId)
    .run();
}
