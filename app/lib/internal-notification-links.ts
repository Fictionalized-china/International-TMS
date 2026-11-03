import { dispatchWorkspaceHref } from "./transport-workspace-access";

/** Resolve historical dispatch links without modifying notification history. */
export function internalNotificationObjectHref(notification: { category: string; link: string | null }) {
  const link = notification.link;
  if (!link || !link.startsWith("/") || link.startsWith("//")) return null;
  const url = new URL(link, "https://tms.invalid");
  if (notification.category === "dispatch_request") {
    const moduleMatch = url.pathname.match(/^\/admin\/orders\/([^/]+)\/modules\/dispatch\/?$/i);
    if (moduleMatch) {
      try { return dispatchWorkspaceHref(decodeURIComponent(moduleMatch[1])); }
      catch { return dispatchWorkspaceHref(); }
    }
    if (/^\/admin\/(tracking-center|workbenches\/dispatch)\/?$/i.test(url.pathname)) return dispatchWorkspaceHref();
  }
  if (notification.category === "dispatch_ready" && url.pathname === "/admin/tracking-center") return "/admin/orders";
  return link;
}
