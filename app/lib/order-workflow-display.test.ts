import { describe, expect, it } from "vitest";
import { displayWorkflowSteps, hasReviewAssignmentWorkspace, resolveReviewAssignmentStep } from "./order-workflow-display";

const standardSteps = [
  { step_key: "order_creation", name: "订单创建", sort_order: 10 },
  { step_key: "consignment_approval", name: "委托审核", sort_order: 30 },
  { step_key: "task_assignment", name: "任务分配", sort_order: 40 },
  { step_key: "domestic_execution", name: "国内运输", sort_order: 50 },
];

describe("operator-facing order workflow stages", () => {
  it("opens assignment on the same approval URL only after the server advances", () => {
    expect(resolveReviewAssignmentStep(standardSteps, "consignment_approval", "task_assignment")).toBe("task_assignment");
    expect(resolveReviewAssignmentStep(standardSteps, "task_assignment", "consignment_approval")).toBe("consignment_approval");
  });

  it("keeps other stages and completed history independent", () => {
    expect(resolveReviewAssignmentStep(standardSteps, "order_creation", "task_assignment")).toBe("order_creation");
    expect(resolveReviewAssignmentStep(standardSteps, "consignment_approval", "domestic_execution")).toBe("consignment_approval");
    expect(hasReviewAssignmentWorkspace(standardSteps.filter((step) => step.step_key !== "task_assignment"))).toBe(false);
  });
  it.each(["consignment_approval", "task_assignment"])(
    "shows %s as the same stage while keeping its internal checkpoint link",
    (activeStepKey) => {
      const visible = displayWorkflowSteps(standardSteps, activeStepKey);
      const combined = visible.find((step) => step.name === "审核分配");

      expect(visible.map((step) => step.name)).toEqual([
        "订单创建",
        "审核分配",
        "国内运输",
      ]);
      expect(combined?.step_key).toBe(activeStepKey);
      expect(combined?.member_step_keys).toEqual([
        "consignment_approval",
        "task_assignment",
      ]);
    },
  );

  it("does not group the checkpoints when a customized workflow separates them", () => {
    const customized = [
      standardSteps[0],
      standardSteps[1],
      { step_key: "custom_gate", name: "自定义校验", sort_order: 35 },
      standardSteps[2],
    ];
    expect(hasReviewAssignmentWorkspace(customized)).toBe(false);
    expect(resolveReviewAssignmentStep(customized, "consignment_approval", "task_assignment")).toBe("consignment_approval");

    expect(displayWorkflowSteps(customized, "consignment_approval").map((step) => step.name)).toEqual([
      "订单创建",
      "委托审核",
      "自定义校验",
      "任务分配",
    ]);
  });
});
