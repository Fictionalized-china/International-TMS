import { describe, expect, it } from "vitest";
import { describeCustomerAccess } from "./customer-access-view";

describe("customer access presentation", () => {
  it("explains the sales own-customer scope and keeps registration review unavailable", () => {
    const access = describeCustomerAccess({
      permissions: ["customer.view", "customer.manage", "customer.scope.own"],
      roleCodes: ["pos_sales"],
    });
    expect(access).toMatchObject({
      scope: "own",
      scopeLabel: "本人客户",
      operationLabel: "可维护",
      canManage: true,
      canReviewRegistrations: false,
    });
    expect(access.description).toContain("其他业务员客户不会显示");
  });

  it("explains the customer-service all-customer scope as read only", () => {
    const access = describeCustomerAccess({
      permissions: ["customer.view", "customer.scope.all"],
      roleCodes: ["pos_customer_service"],
    });
    expect(access).toMatchObject({
      scope: "all",
      scopeLabel: "全部客户",
      operationLabel: "只读",
      canManage: false,
      canReviewRegistrations: false,
    });
    expect(access.description).toContain("新增和编辑由业务岗或老板办理");
  });

  it("lets protected managers review registrations when management is enabled", () => {
    expect(describeCustomerAccess({
      permissions: ["customer.view", "customer.manage"],
      roleCodes: ["boss"],
    })).toMatchObject({
      scope: "all",
      canManage: true,
      canReviewRegistrations: true,
    });
  });
});
