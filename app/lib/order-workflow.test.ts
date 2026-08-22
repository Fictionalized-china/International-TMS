import { describe, expect, it } from "vitest";
import { isAssignedOrderApprover } from "./order-workflow";

describe("assigned order approval", () => {
  it("allows only the assigned user while the order is submitted", () => {
    expect(
      isAssignedOrderApprover({
        status: "submitted",
        currentAssigneeUserId: "reviewer-1",
        currentUserId: "reviewer-1",
      }),
    ).toBe(true);
    expect(
      isAssignedOrderApprover({
        status: "submitted",
        currentAssigneeUserId: "reviewer-1",
        currentUserId: "reviewer-2",
      }),
    ).toBe(false);
  });

  it("does not allow approval outside the submitted state", () => {
    expect(
      isAssignedOrderApprover({
        status: "confirmed",
        currentAssigneeUserId: "reviewer-1",
        currentUserId: "reviewer-1",
      }),
    ).toBe(false);
    expect(
      isAssignedOrderApprover({
        status: "submitted",
        currentAssigneeUserId: null,
        currentUserId: "reviewer-1",
      }),
    ).toBe(false);
  });
});
