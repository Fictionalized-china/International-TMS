import { isProtectedAccessRole } from "./permission-blocks";

export type CustomerAccessScope = "all" | "own" | "none";

type CustomerAccessViewUser = {
  permissions: readonly string[];
  roleCodes?: readonly string[] | null;
};

export function describeCustomerAccess(user: CustomerAccessViewUser) {
  const hasAllScope = isProtectedAccessRole(user.roleCodes)
    || user.permissions.includes("customer.scope.all");
  const scope: CustomerAccessScope = hasAllScope
    ? "all"
    : user.permissions.includes("customer.scope.own")
      ? "own"
      : "none";
  const canManage = user.permissions.includes("customer.manage");

  const scopeLabel = scope === "all"
    ? "全部客户"
    : scope === "own"
      ? "本人客户"
      : "无客户数据范围";
  const operationLabel = canManage ? "可维护" : "只读";
  const description = scope === "all"
    ? canManage
      ? "当前显示组织内全部客户，可新增和维护客户档案。"
      : "当前显示组织内全部客户；当前岗位仅可查看，新增和编辑由业务岗或老板办理。"
    : scope === "own"
      ? canManage
        ? "当前仅显示由你负责的客户，可新增和维护本人客户；其他业务员客户不会显示。"
        : "当前仅显示由你负责的客户，且当前岗位仅可查看。"
      : "当前账号没有客户数据范围，如需查看请由管理员配置客户范围权限。";

  return {
    scope,
    scopeLabel,
    operationLabel,
    description,
    canManage,
    canReviewRegistrations: hasAllScope && canManage,
  };
}
