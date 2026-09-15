import { env } from "cloudflare:workers";
import { requireSessionUser } from "./auth.server";

export async function requirePortalCustomer(request: Request) {
  const user = await requireSessionUser(request, undefined, "portal");
  const customer = await env.DB.prepare("SELECT c.id, c.code, c.name, c.status FROM customer_portal_accounts cpa JOIN customers c ON c.id = cpa.customer_id WHERE cpa.user_id = ? AND cpa.organization_id = ? AND cpa.status = 'active' LIMIT 1").bind(user.userId, user.organizationId).first<{ id:string; code:string; name:string; status:string }>();
  if (!customer) throw new Response("客户门户账户未关联客户", { status: 403 });
  return { user, customer };
}
