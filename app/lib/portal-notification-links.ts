const PORTAL_ORIGIN = "https://portal.local";

export function portalOrderListLink(orderNumber: string) {
  return `/portal/orders?keyword=${encodeURIComponent(orderNumber)}`;
}

export function normalizePortalNotificationLink(link: string | null) {
  if (!link) return null;

  try {
    const url = new URL(link, PORTAL_ORIGIN);
    if (url.origin !== PORTAL_ORIGIN || url.pathname !== "/portal/orders") return link;

    const legacyOrder = url.searchParams.get("order");
    if (!url.searchParams.has("keyword") && legacyOrder) {
      url.searchParams.set("keyword", legacyOrder);
      url.searchParams.delete("order");
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return link;
  }
}
