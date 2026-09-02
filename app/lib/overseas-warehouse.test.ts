import { describe, expect, it } from "vitest";
import {
  customerFacingOrderStatusLabel,
  nextOverseasAction,
  overseasOperationProgress,
} from "./overseas-warehouse";

describe("overseas warehouse flow", () => {
  it("keeps the handling sequence obvious", () => {
    expect(nextOverseasAction(null)).toBe("确认目的仓到仓");
    expect(nextOverseasAction("arrived")).toBe("系统自动通知客户");
    expect(nextOverseasAction("notified")).toBe("客户预约或到仓扫码自提");
    expect(nextOverseasAction("appointment")).toBe("由境外仓扫码自提出库");
    expect(nextOverseasAction("picked_up")).toBe("进入费用结算");
  });

  it("reports stable progress snapshots", () => {
    expect(overseasOperationProgress.waiting_arrival).toBe(0);
    expect(overseasOperationProgress.arrived).toBe(25);
    expect(overseasOperationProgress.notified).toBe(60);
    expect(overseasOperationProgress.appointment).toBe(75);
    expect(overseasOperationProgress.picked_up).toBe(100);
  });

  it("shows the customer-facing warehouse status after arrival", () => {
    expect(customerFacingOrderStatusLabel("in_execution", "arrived")).toBe(
      "已到仓待自提",
    );
    expect(customerFacingOrderStatusLabel("in_execution", "notified")).toBe(
      "已到仓待自提",
    );
    expect(customerFacingOrderStatusLabel("in_execution", "appointment")).toBe(
      "已到仓待自提",
    );
    expect(customerFacingOrderStatusLabel("in_execution", "picked_up")).toBe(
      "已自提签收",
    );
    expect(customerFacingOrderStatusLabel("in_execution", null)).toBe(
      "运输执行中",
    );
  });
});
