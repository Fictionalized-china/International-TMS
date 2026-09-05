import { describe, expect, it } from "vitest";
import { accessModelRolePermissions } from "./access-model-seed.server";
import {
  standardRoadWorkflowModules,
  standardRoadWorkflowType,
} from "./standard-road-workflow";
import { validateWorkflowResponsibilityReadiness } from "./workflow-publication-validation";

const positionRole: Record<string, keyof typeof accessModelRolePermissions> = {
  SALES: "pos_sales",
  BUSINESS_SUPERVISOR: "pos_business_supervisor",
  OPERATION_SUPERVISOR: "pos_operation_supervisor",
  CS: "pos_customer_service",
  OPERATION: "pos_operation",
  DOC: "pos_doc",
  WAREHOUSE: "warehouse_operator",
  OVERSEAS_WAREHOUSE: "overseas_warehouse_operator",
  FINANCE_ACCOUNTING: "pos_finance",
};

describe("standard road workflow factory defaults", () => {
  it("seeds the expected road type for every built-in family", () => {
    expect(standardRoadWorkflowType("tms-road-pending")).toBe("ltl");
    expect(standardRoadWorkflowType("tms-default")).toBe("ltl");
    expect(standardRoadWorkflowType("tms-ftl-standard")).toBe("ftl");
  });

  it("contains every core gate and keeps only supporting work optional", () => {
    const required = new Set(
      standardRoadWorkflowModules
        .filter((module) => module.required)
        .map((module) => `${module.stepKey}:${module.moduleCode}`),
    );
    expect(required).toEqual(new Set([
      "quotation:consignment",
      "order_creation:consignment",
      "consignment_approval:consignment",
      "task_assignment:assignment",
      "domestic_execution:transport",
      "warehouse_receiving:warehouse",
      "port_loading:loading",
      "outbound_transport:customs",
      "outbound_transport:tracking",
      "overseas_pickup:overseas_warehouse",
      "reconciliation:costs",
      "completion_review:review",
    ]));
    expect(
      standardRoadWorkflowModules
        .filter((module) => !module.required)
        .map((module) => `${module.stepKey}:${module.moduleCode}`),
    ).toEqual([
      "order_creation:cargo",
      "order_creation:costs",
      "outbound_transport:documents",
      "completion_review:exceptions",
    ]);
  });

  it("uses the runtime auto-completion task-key convention for every factory task", () => {
    for (const module of standardRoadWorkflowModules) {
      const expectedTaskKey = module.stepKey === "quotation"
        ? "handle_quotation"
        : `handle_${module.moduleCode}`;
      expect(module.taskKey).toBe(expectedTaskKey);
    }
  });
  it("keeps the three-party settlement owners aligned with runtime authorization", () => {
    const settlement = standardRoadWorkflowModules.find(
      (module) => module.stepKey === "reconciliation" && module.moduleCode === "costs",
    );
    const review = standardRoadWorkflowModules.find(
      (module) => module.stepKey === "completion_review" && module.moduleCode === "review",
    );

    expect(settlement?.responsibilityPositionCode).toBe("CS");
    expect(review?.responsibilityPositionCode).toBe("FINANCE_ACCOUNTING");
    expect(positionRole.SALES).toBe("pos_sales");
  });


  it("routes every human task to a seeded permission-capable position", () => {
    const stepKeys = [...new Set(standardRoadWorkflowModules.map((module) => module.stepKey))];
    const steps = stepKeys.map((stepKey, index) => ({
      id: `step:${stepKey}`,
      step_key: stepKey,
      name: stepKey,
      is_active: 1,
      sort_order: index + 1,
    }));
    const modules = standardRoadWorkflowModules.map((module) => ({
      id: `module:${module.stepKey}:${module.moduleCode}`,
      step_id: `step:${module.stepKey}`,
      module_code: module.moduleCode,
      display_name: module.displayName,
      is_active: 1,
      responsibility_position_code: module.responsibilityPositionCode,
      completion_mode: module.completionMode,
    }));
    const tasks = standardRoadWorkflowModules.map((module) => ({
      id: `task:${module.stepKey}:${module.moduleCode}`,
      step_module_id: `module:${module.stepKey}:${module.moduleCode}`,
      name: module.taskName,
      task_type: module.taskType,
      is_required: module.taskRequired ? 1 : 0,
      is_active: 1,
      responsibility_position_code: module.responsibilityPositionCode,
    }));
    const positions = Object.entries(positionRole).map(([code, role]) => ({
      code,
      name: code,
      status: "active",
      active_member_count: 1,
      permission_codes: accessModelRolePermissions[role].join(","),
    }));

    expect(validateWorkflowResponsibilityReadiness({
      steps,
      modules,
      tasks,
      positions,
    })).toEqual([]);
  });
});
