import { describe, expect, it } from "vitest";
import { buildStageSnapshots, orderNextGuidance, type GuidanceModule } from "./order-guidance";

const module = (overrides: Partial<GuidanceModule>): GuidanceModule => ({
  module_code: "cargo",
  module_name: "货物信息",
  enabled: 1,
  is_required: 1,
  status: "not_started",
  current_step_code: null,
  current_step_name: "货物复核",
  blocking_reason: null,
  assignee_name: null,
  progress_percent: 0,
  ...overrides,
});

describe("order next guidance", () => {
  it("guides a draft to cargo confirmation before submit", () => {
    const result = orderNextGuidance({ orderId: "o1", orderStatus: "draft", modules: [module({})] });
    expect(result.action).toContain("货物");
    expect(result.href).toContain("/modules/cargo");
  });

  it("guides a confirmed order to assignment", () => {
    const result = orderNextGuidance({
      orderId: "o1",
      orderStatus: "confirmed",
      modules: [module({ module_code: "assignment", module_name: "任务分配" })],
    });
    expect(result.stage.code).toBe("review_assignment");
    expect(result.moduleCode).toBe("assignment");
  });

  it("skips service modules that are not enabled", () => {
    const snapshots = buildStageSnapshots("in_execution", [
      module({ module_code: "overseas_warehouse", enabled: 0, status: "not_applicable" }),
      module({ module_code: "costs", module_name: "费用结算" }),
    ]);
    expect(snapshots[5].status).toBe("skipped");
    expect(snapshots[6].status).toBe("active");
  });
});
