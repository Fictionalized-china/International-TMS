import type { Site } from "./site.server";

export const SESSION_SLOT_PARAM = "itmsTab";
export const SESSION_SLOT_HEADER = "X-ITMS-Tab";

const SESSION_SLOT_PATTERN = /^[a-zA-Z0-9_-]{12,64}$/;

export function normalizeSessionSlot(value: string | null | undefined): string | null {
  const candidate = value?.trim() ?? "";
  return SESSION_SLOT_PATTERN.test(candidate) ? candidate : null;
}

export function createSessionSlot(): string {
  return crypto.randomUUID();
}

export function sessionSlotFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeSessionSlot(new URL(value, "http://itms.local").searchParams.get(SESSION_SLOT_PARAM));
  } catch {
    return null;
  }
}

export function sessionSlotFromRequest(request: Request): string | null {
  return (
    sessionSlotFromUrl(request.url) ||
    normalizeSessionSlot(request.headers.get(SESSION_SLOT_HEADER)) ||
    sessionSlotFromUrl(request.headers.get("Referer"))
  );
}

export function withSessionSlot(location: string, sessionSlot: string | null | undefined): string {
  const normalized = normalizeSessionSlot(sessionSlot);
  if (!normalized) return location;
  const url = new URL(location, "http://itms.local");
  url.searchParams.set(SESSION_SLOT_PARAM, normalized);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sessionCookieName(
  site: Site,
  warehouseId?: string | null,
  sessionSlot?: string | null,
): string | null {
  const normalized = normalizeSessionSlot(sessionSlot);
  if (!normalized) return null;
  const warehouseSuffix = site === "warehouse" && warehouseId
    ? `_${warehouseId.replace(/[^a-zA-Z0-9_-]/g, "")}`
    : "";
  return `itms_${site}_session${warehouseSuffix}_${normalized}`;
}
