import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import { randomToken, sha256 } from "./crypto.server";
import {
  cookieValueFromHeader,
  portalContextIdFromRequest,
  portalContextualPath,
  portalSessionCookieName,
} from "./portal-session-context";
import type { Site } from "./site.server";
import { siteFromRequest, siteLogin } from "./site.server";
import type { PermissionOverride } from "./permission-blocks";
import {
  loadActivePositionAccessProfile,
  type PositionBusinessDataScope,
} from "./position-access-profile.server";
import { canUseAdminSite } from "./site-account-access";
import { sessionCookieName, sessionSlotFromRequest, withSessionSlot } from "./session-slot";

export type SessionUser = {
  sessionId: string;
  userId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  displayName: string;
  site: Site;
  permissions: string[];
  permissionOverrides?: PermissionOverride[];
  positionCode: string | null;
  roleCodes: string[];
  departmentId: string | null;
  departmentCode: string | null;
  dataScope: PositionBusinessDataScope;
  warehouseIds: string[];
  regionCountryCodes: string[];
};

function cookieValue(request: Request, name: string): string | null {
  return cookieValueFromHeader(request.headers.get("Cookie"), name);
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

function cookieName(site: Site, warehouseId?: string | null, contextId?: string | null): string | null {
  if (site === "portal") return portalSessionCookieName(contextId);
  return sessionCookieName(site, warehouseId, contextId);
}

export async function createSession(
  userId: string,
  organizationId: string,
  site: Site = "admin",
  warehouseId?: string | null,
  contextId?: string | null,
): Promise<string> {
  const name = cookieName(site, warehouseId, contextId);
  if (!name) throw new Error("创建会话时缺少有效的窗口上下文");
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
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;
}

export async function getSessionUser(
  request: Request,
  site: Site = siteFromRequest(request),
  warehouseId?: string | null,
  contextId?: string | null,
): Promise<SessionUser | null> {
  const resolvedWarehouseId = site === "warehouse"
    ? warehouseId || warehouseIdFromRequest(request)
    : null;
  const resolvedContextId = site === "portal"
    ? contextId || portalContextIdFromRequest(request)
    : contextId || sessionSlotFromRequest(request);
  const name = cookieName(site, resolvedWarehouseId, resolvedContextId);
  if (!name) return null;
  const token = cookieValue(request, name);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.site, u.id AS user_id, u.email, u.display_name,
            o.id AS organization_id, o.name AS organization_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = s.organization_id
      WHERE s.token_hash = ? AND s.expires_at > ?
        AND u.status = 'active' AND o.status = 'active'`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<Record<string, string>>();
  if (!row || row.site !== site) return null;
  let permissions: string[] = [];
  let positionCode: string | null = null;
  let roleCodes: string[] = [];
  let departmentId: string | null = null;
  let departmentCode: string | null = null;
  let dataScope: PositionBusinessDataScope = "self";
  let warehouseIds: string[] = [];
  let regionCountryCodes: string[] = [];
  if (site === "portal") {
    const portalAccount = await env.DB.prepare(
      `SELECT 1 FROM customer_portal_accounts
       WHERE user_id=? AND organization_id=? AND status='active'`,
    ).bind(row.user_id, row.organization_id).first();
    if (!portalAccount) return null;
  } else {
    const accessProfile = await loadActivePositionAccessProfile(
      env.DB,
      row.organization_id,
      row.user_id,
    );
    if (!accessProfile) return null;
    if (site === "admin" && !canUseAdminSite([accessProfile.roleCode])) return null;
    if (site === "warehouse" && !accessProfile.permissions.includes("warehouse.view")) return null;
    permissions = accessProfile.permissions;
    positionCode = accessProfile.positionCode;
    roleCodes = [accessProfile.roleCode];
    departmentId = accessProfile.departmentId;
    departmentCode = accessProfile.departmentCode;
    dataScope = accessProfile.dataScope;
    if (["warehouse", "region"].includes(dataScope)) {
      const warehouseAccess = await env.DB.prepare(
        `SELECT warehouse.id,warehouse.country_code
           FROM warehouse_user_access access
           JOIN warehouses warehouse
             ON warehouse.id=access.warehouse_id
            AND warehouse.organization_id=access.organization_id
            AND warehouse.status='active'
          WHERE access.organization_id=? AND access.user_id=?
            AND access.access_level IN ('operator','manager')
          ORDER BY warehouse.code`,
      ).bind(row.organization_id, row.user_id).all<{ id: string; country_code: string }>();
      warehouseIds = warehouseAccess.results.map((warehouse) => warehouse.id);
      regionCountryCodes = [...new Set(
        warehouseAccess.results.map((warehouse) => warehouse.country_code).filter(Boolean),
      )];
    }
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    displayName: row.display_name,
    site: row.site as Site,
    permissions,
    permissionOverrides: [],
    positionCode,
    roleCodes,
    departmentId,
    departmentCode,
    dataScope,
    warehouseIds,
    regionCountryCodes,
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
  const sessionSlot = sessionSlotFromRequest(request);
  const portalContextId = site === "portal" ? portalContextIdFromRequest(request) : null;
  const loginLocation = portalContextId
    ? portalContextualPath(siteLogin(site), portalContextId)
    : withSessionSlot(siteLogin(site), sessionSlot);
  const requestedSite=siteFromRequest(request);
  if (requestedSite!==site) {
    const requestedLogin = requestedSite === "portal" && portalContextId
      ? portalContextualPath(siteLogin(requestedSite), portalContextId)
      : withSessionSlot(siteLogin(requestedSite), sessionSlot);
    throw redirect(requestedLogin);
  }
  if (!user || user.site !== site) throw redirect(loginLocation);
  if (permission && !user.permissions.includes(permission)) throw new Response("没有权限执行此操作", { status: 403 });
  return user;
}

export async function destroySession(
  request: Request,
  site: Site = siteFromRequest(request),
  warehouseId?: string | null,
  contextId?: string | null,
): Promise<string> {
  const resolvedWarehouseId = site === "warehouse"
    ? warehouseId || warehouseIdFromRequest(request)
    : null;
  const resolvedContextId = site === "portal"
    ? contextId || portalContextIdFromRequest(request)
    : contextId || sessionSlotFromRequest(request);
  const name = cookieName(site, resolvedWarehouseId, resolvedContextId);
  if (!name) return "itms_portal_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
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
