import { describe, expect, it } from "vitest";
import { orderCollaborationNotice } from "./order-collaboration";

describe("order collaboration notice", () => {
  it("shows the assigned business supervisor while an order is waiting for approval", () => {
    expect(orderCollaborationNotice({
      orderStatus: "submitted",
      currentStepKey: "consignment_approval",
      moduleCode: "consignment",
      assigneeName: "业务主管账号",
    })).toEqual({
      title: "待业务主管（业务主管账号）审批",
      progress: "当前进度：委托资料已提交，正在等待业务主管审核。",
    });
  });

  it("does not show a waiting card to the person currently assigned to act", () => {
    expect(orderCollaborationNotice({
      orderStatus: "submitted",
      currentStepKey: "consignment_approval",
      moduleCode: "consignment",
      assigneeName: "业务主管账号",
      currentUserId: "user-supervisor",
      assigneeUserId: "user-supervisor",
    })).toBeNull();
  });

  it("explains that domestic transport is still under way at warehouse receiving", () => {
    expect(orderCollaborationNotice({
      orderStatus: "in_execution",
      currentStepKey: "warehouse_receiving",
      moduleCode: "warehouse",
    })).toEqual({
      title: "待国内仓扫码入仓",
      progress: "当前进度：国内运输已安排，货物正在国内段运输。",
    });
  });

  it("does not show a collaboration card while the salesperson is completing the draft", () => {
    expect(orderCollaborationNotice({
      orderStatus: "draft",
      currentStepKey: "order_creation",
      moduleCode: "consignment",
    })).toBeNull();
  });
});
