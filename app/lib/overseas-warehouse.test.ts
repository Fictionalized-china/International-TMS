import { describe, expect, it } from "vitest";
import {
  nextOverseasAction,
  overseasOperationProgress,
} from "./overseas-warehouse";

describe("overseas warehouse flow", () => {
  it("keeps the handling sequence obvious", () => {
    expect(nextOverseasAction(null)).toBe("确认目的仓到仓");
    expect(nextOverseasAction("arrived")).toBe("系统自动通知客户");
    expect(nextOverseasAction("notified")).toBe("登记提货预约");
    expect(nextOverseasAction("appointment")).toBe("由境外仓扫码自提出库");
    expect(nextOverseasAction("picked_up")).toBe("进入费用结算");
  });

  it("reports stable progress snapshots", () => {
    expect(overseasOperationProgress.waiting_arrival).toBe(0);
    expect(overseasOperationProgress.arrived).toBe(25);
    expect(overseasOperationProgress.notified).toBe(50);
    expect(overseasOperationProgress.appointment).toBe(75);
    expect(overseasOperationProgress.picked_up).toBe(100);
  });
});
