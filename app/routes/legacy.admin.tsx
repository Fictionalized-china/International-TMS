import { redirect } from "react-router";
import type { Route } from "./+types/legacy.admin";

const destinations: Record<string, string> = {
  "/dashboard": "/admin",
  "/users": "/admin/users",
  "/roles": "/admin/roles",
  "/audit": "/admin/audit",
};

export function loader({ request }: Route.LoaderArgs) {
  throw redirect(destinations[new URL(request.url).pathname] ?? "/admin");
}

export default function LegacyAdminRoute() {
  return null;
}
