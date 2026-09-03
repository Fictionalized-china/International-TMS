import { describe, expect, it } from "vitest";
import { batchVisibilitySql, canSeeScopedOrder, orderVisibilitySql } from "./order-access";

const baseUser = {
  userId: "user-a",
  organizationId: "org-a",
  positionCode: "OPERATION",
  roleCodes: ["pos_operation"],
  permissions: ["order.view", "order.scope.assigned"],
};

describe("order access", () => {
  it("shows an unassigned current task to its responsible position pool", () => {
    expect(canSeeScopedOrder(baseUser, {
      assignee_user_id: null,
      responsible_position_code: "OPERATION",
    })).toBe(true);
  });

  it("removes a claimed task from other accounts in the same position", () => {
    expect(canSeeScopedOrder(baseUser, {
      assignee_user_id: "user-b",
      responsible_position_code: "OPERATION",
    })).toBe(false);
    const scopedSql = orderVisibilitySql(baseUser).sql;
    expect(scopedSql).toContain("current_assignee_user_id IS NULL AND EXISTS");
  });

  it("keeps a sales user's own order visible for the full lifecycle", () => {
    expect(canSeeScopedOrder({
      ...baseUser,
      positionCode: "SALES",
      permissions: ["order.view", "order.scope.sales_own"],
    }, {
      salesperson_user_id: "user-a",
      assignee_user_id: "user-b",
      responsible_position_code: "TRACKING",
    })).toBe(true);
  });

  it("grants owner and all-scope accounts every order", () => {
    expect(orderVisibilitySql({ ...baseUser, roleCodes: ["owner"] }).sql).toBe("1=1");
    expect(canSeeScopedOrder({
      ...baseUser,
      permissions: ["order.view", "order.scope.all"],
    }, {})).toBe(true);
  });

  it("limits a transport batch to batches containing at least one visible order", () => {
    const visibility = batchVisibilitySql(baseUser, "batch");
    expect(visibility.sql).toContain("access_batch_order.batch_id=batch.id");
    expect(visibility.sql).toContain("access_order.current_assignee_user_id");
    expect(visibility.values).toEqual(["user-a", "user-a", "OPERATION"]);
  });
});
