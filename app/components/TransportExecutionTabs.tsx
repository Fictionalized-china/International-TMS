import type { AdminNavigationUser } from "../lib/admin-navigation";
import { AdminWorkspaceTabs } from "./AdminWorkspaceTabs";

export function TransportExecutionTabs({ user }: { user: AdminNavigationUser }) {
  return <AdminWorkspaceTabs user={user} workspace="trackingCenter" />;
}
