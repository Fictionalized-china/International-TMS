export const PORTAL_CONTEXT_PARAM = "portalContext";

const PORTAL_CONTEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PORTAL_ORIGIN = "https://portal.local";

export function normalizePortalContextId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return PORTAL_CONTEXT_PATTERN.test(normalized) ? normalized : null;
}

export function portalContextIdFromRequest(request: Request): string | null {
  return normalizePortalContextId(new URL(request.url).searchParams.get(PORTAL_CONTEXT_PARAM));
}

export function portalSessionCookieName(contextId: string | null | undefined): string | null {
  const normalized = normalizePortalContextId(contextId);
  return normalized ? `itms_portal_session_${normalized}` : null;
}

export function portalContextualPath(
  to: string,
  contextId: string,
  currentPath = "/portal",
): string {
  const normalized = normalizePortalContextId(contextId);
  if (!normalized) throw new Error("无效的客户门户窗口上下文");

  const current = new URL(currentPath, PORTAL_ORIGIN);
  const target = to === "." ? new URL(`${current.pathname}${current.search}`, PORTAL_ORIGIN) : new URL(to, current);
  if (target.origin !== PORTAL_ORIGIN) return to;
  target.searchParams.set(PORTAL_CONTEXT_PARAM, normalized);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function cookieValueFromHeader(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function portalSessionTokenFromCookieHeader(
  header: string | null | undefined,
  contextId: string | null | undefined,
): string | null {
  const name = portalSessionCookieName(contextId);
  return name ? cookieValueFromHeader(header, name) : null;
}
