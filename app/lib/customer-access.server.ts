import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { isProtectedAccessRole } from "./permission-blocks";

type CustomerAccessUser = Pick<SessionUser, "userId" | "organizationId" | "permissions" | "roleCodes">;

export function canViewAllCustomers(user: CustomerAccessUser) {
  return isProtectedAccessRole(user.roleCodes) || user.permissions.includes("customer.scope.all");
}
export function customerVisibilitySql(user: CustomerAccessUser, alias = "c") {
  if (canViewAllCustomers(user)) return { sql: "1=1", values: [] as string[] };
  if (user.permissions.includes("customer.scope.own")) {
    return { sql: `${alias}.sales_owner_user_id=?`, values: [user.userId] };
  }
  return { sql: "0=1", values: [] as string[] };
}

export async function requireCustomerAccess(user: CustomerAccessUser, customerId: string) {
  const visibility = customerVisibilitySql(user, "c");
  const customer = await env.DB.prepare(
    `SELECT c.id FROM customers c
     WHERE c.organization_id=? AND c.id=? AND ${visibility.sql}`,
  ).bind(user.organizationId, customerId, ...visibility.values).first<{ id: string }>();
  if (!customer) throw new Response("客户不存在或不在您的数据范围内", { status: 404 });
  return customer;
}
