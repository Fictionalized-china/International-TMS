import { Link, useLocation } from "react-router";
import type { AdminNavigationUser } from "../lib/admin-navigation";
import {
  adminWorkspaceHref,
  adminWorkspaceSectionActive,
  adminWorkspaceSections,
  type AdminWorkspaceKey,
} from "../lib/admin-workspace-navigation";

export function AdminWorkspaceTabs({ user, workspace }: { user: AdminNavigationUser; workspace: AdminWorkspaceKey }) {
  const location = useLocation();
  const sections = adminWorkspaceSections(user, workspace);
  if (!sections.length) return null;
  return <nav className="peer-page-tabs admin-workspace-tabs" aria-label="当前板块子页面">
    {sections.map(section => {
      const active = adminWorkspaceSectionActive(section, location.pathname, location.search);
      return <Link key={section.key} to={adminWorkspaceHref(section.href, location.search)}
        className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>{section.label}</Link>;
    })}
  </nav>;
}
