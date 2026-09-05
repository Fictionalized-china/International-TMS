import { redirect } from "react-router";
import type { Route } from "./+types/portal.quotes";
import { handlePortalQuotationAction } from "../lib/portal-quotation-action.server";
import { requirePortalCustomer } from "../lib/portal.server";

const legacyQuoteStatusMap: Record<string, string> = {
  pending: "quote_pending",
  withdrawn: "quote_withdrawn",
  void: "quote_void",
};

export async function loader({ request }: Route.LoaderArgs) {
  await requirePortalCustomer(request);
  return redirect(legacyPortalQuotesRedirectPath(request.url));
}

export async function action({ request }: Route.ActionArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  return handlePortalQuotationAction({ request, user, customer });
}

export function legacyPortalQuotesRedirectPath(requestUrl: string) {
  const source = new URL(requestUrl);
  const target = new URL("/portal/orders", source.origin);
  const legacyStatus = source.searchParams.get("status") || "";
  const quote = source.searchParams.get("quote") || "";
  const portalContext = source.searchParams.get("portalContext") || "";
  if (legacyQuoteStatusMap[legacyStatus]) target.searchParams.set("status", legacyQuoteStatusMap[legacyStatus]);
  if (quote) target.searchParams.set("quote", quote);
  if (portalContext) target.searchParams.set("portalContext", portalContext);
  return `${target.pathname}${target.search}`;
}

export default function LegacyPortalQuotesRedirect() {
  return null;
}

export function meta() { return [{ title: "我的订单 | 新翎航客户门户" }]; }
