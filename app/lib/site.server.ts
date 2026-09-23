export type Site = "admin" | "portal" | "warehouse";

export function siteFromRequest(request: Request): Site {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const pathname = new URL(request.url).pathname.toLowerCase();
  if (hostname === "warehouse.oulingtruck.com" || hostname.startsWith("warehouse.") || pathname.startsWith("/warehouse")) return "warehouse";
  if (hostname === "portal.oulingtruck.com" || hostname.startsWith("portal.") || hostname.startsWith("track.") || pathname.startsWith("/portal")) return "portal";
  return "admin";
}

export function siteHomeFromRequest(request: Request): string {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname.startsWith("track.")) return "/portal/tracking";
  return siteHome(siteFromRequest(request));
}

export function siteHome(site: Site): string {
  return site === "portal" ? "/portal" : site === "warehouse" ? "/warehouse" : "/admin/portal";
}

export function siteLogin(site: Site): string {
  return site === "portal" ? "/portal/login" : site === "warehouse" ? "/warehouse/login" : "/login";
}
