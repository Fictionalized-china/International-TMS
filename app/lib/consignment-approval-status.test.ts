import { describe, expect, it } from "vitest";
import { consignmentApprovalStatusRows } from "./consignment-approval-status";

describe("consignment approval read-only status", () => {
  it("shows a submitted order as waiting for its assigned business supervisor", () => {
    const rows = consignmentApprovalStatusRows({
      orderStatus: "submitted",
      currentAssigneeName: "业务主管账号",
      history: [{
        actionCode: "submit",
        actionName: "提交审批",
        actorName: "业务员账号",
        assigneeName: "业务主管账号",
        notes: "请审核",
        occurredAt: "2026-09-05T08:00:00.000Z",
      }],
    });

    expect(rows).toMatchObject([
      { key: "submission", statusLabel: "已提交", owner: "业务员账号" },
      { key: "approval", statusLabel: "待审批", owner: "业务主管账号" },
      { key: "assignment", statusLabel: "未开始" },
    ]);
  });

  it("shows the approver and next operation supervisor after approval", () => {
    const rows = consignmentApprovalStatusRows({
      orderStatus: "confirmed",
      history: [
        {
          actionCode: "approve",
          actionName: "审批通过",
          actorName: "业务主管账号",
          assigneeName: "操作主管账号",
          notes: "资料完整",
          occurredAt: "2026-09-05T08:05:00.000Z",
        },
        {
          actionCode: "submit",
          actionName: "提交审批",
          actorName: "业务员账号",
          assigneeName: "业务主管账号",
          notes: null,
          occurredAt: "2026-09-05T08:00:00.000Z",
        },
      ],
    });

    expect(rows[1]).toMatchObject({
      statusLabel: "已通过",
      owner: "业务主管账号",
      note: "资料完整",
    });
    expect(rows[2]).toMatchObject({
      statusLabel: "待分配",
      owner: "操作主管账号",
    });
  });

  it("shows the returned state when the latest submission was sent back", () => {
    const rows = consignmentApprovalStatusRows({
      orderStatus: "draft",
      history: [
        {
          actionCode: "reject",
          actionName: "审批打回",
          actorName: "业务主管账号",
          assigneeName: "业务员账号",
          notes: "补充委托书",
          occurredAt: "2026-09-05T08:10:00.000Z",
        },
        {
          actionCode: "submit",
          actionName: "提交审批",
          actorName: "业务员账号",
          assigneeName: "业务主管账号",
          notes: null,
          occurredAt: "2026-09-05T08:00:00.000Z",
        },
      ],
    });

    expect(rows[0]).toMatchObject({ statusLabel: "已退回", note: "补充委托书" });
    expect(rows[1]).toMatchObject({ statusLabel: "已退回" });
  });

  it("does not reuse an approval from an older submission cycle", () => {
    const rows = consignmentApprovalStatusRows({
      orderStatus: "submitted",
      currentAssigneeName: "新业务主管",
      history: [
        {
          actionCode: "submit",
          actionName: "重新提交审批",
          actorName: "业务员账号",
          assigneeName: "新业务主管",
          notes: null,
          occurredAt: "2026-09-05T09:00:00.000Z",
        },
        {
          actionCode: "approve",
          actionName: "审批通过",
          actorName: "原业务主管",
          assigneeName: "原操作主管",
          notes: "旧轮次意见",
          occurredAt: "2026-09-05T08:00:00.000Z",
        },
      ],
    });

    expect(rows[1]).toMatchObject({ statusLabel: "待审批", owner: "新业务主管" });
    expect(rows[2]).toMatchObject({ statusLabel: "未开始", owner: "待审批通过后指定" });
  });
});
