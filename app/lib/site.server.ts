export type Site = "admin" | "portal" | "warehouse";

export function siteFromRequest(request: Request): Site {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const pathname = new URL(request.url).pathname.toLowerCase();
  if (hostname === "warehouse.oulingtruck.com" || hostname.startsWith("warehouse.") || pathname.startsWith("/warehouse")) return "warehouse";
  if (hostname === "portal.oulingtruck.com" || hostname.startsWith("portal.") || pathname.startsWith("/portal")) return "portal";
  return "admin";
}

export function siteHome(site: Site): string {
  return site === "portal" ? "/portal" : site === "warehouse" ? "/warehouse" : "/admin";
}

export function siteLogin(site: Site): string {
  return site === "portal" ? "/portal/login" : site === "warehouse" ? "/warehouse/login" : "/login";
}
