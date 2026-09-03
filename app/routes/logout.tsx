import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { destroySession, getSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { siteFromRequest, siteLogin, type Site } from "../lib/site.server";
import { portalContextIdFromRequest, portalContextualPath } from "../lib/portal-session-context";
import { sessionSlotFromRequest, withSessionSlot } from "../lib/session-slot";

export async function action({ request }: Route.ActionArgs) {
  const requestedSite = new URL(request.url).searchParams.get("site");
  const site: Site = requestedSite === "portal" || requestedSite === "warehouse" || requestedSite === "admin"
    ? requestedSite
    : siteFromRequest(request);
  const user = await getSessionUser(request, site);
  if (user) await writeAudit({ request, action: "auth.logout", resourceType: "session", resourceId: user.sessionId, organizationId: user.organizationId, actorUserId: user.userId });
  const destination = siteLogin(user?.site ?? site);
  const portalContextId = site === "portal" ? portalContextIdFromRequest(request) : null;
  const contextualDestination = portalContextId
    ? portalContextualPath(destination, portalContextId)
    : withSessionSlot(destination, sessionSlotFromRequest(request));
  return redirect(contextualDestination, { headers: { "Set-Cookie": await destroySession(request, site) } });
}
