import { NavLink } from "react-router";

type OrganizationAccessTabsProps = {
  permissions: string[];
};

export function OrganizationAccessTabs({ permissions }: OrganizationAccessTabsProps) {
  const can = (permission: string) => permissions.includes(permission);
  const tabs = [
    can("department.view") && { to: "/admin/departments", label: "组织架构" },
    can("user.view") && { to: "/admin/positions", label: "岗位与账号" },
    can("user.view") && { to: "/admin/users", label: "账号管理" },
    can("role.view") && { to: "/admin/roles", label: "岗位权限" },
  ].filter((tab): tab is { to: string; label: string } => Boolean(tab));

  if (tabs.length < 2) return null;
  return (
    <nav className="peer-page-tabs organization-access-tabs" aria-label="组织与权限">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to}>{tab.label}</NavLink>
      ))}
    </nav>
  );
}
