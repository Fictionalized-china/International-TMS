import { describe, expect, it } from "vitest";
import { resolveConfiguredOrderBusinessTarget } from "./order-business-workflow-target";

const modules = [
  { module_code: "transport", enabled: 1, is_required: 1, status: "not_started" },
  { module_code: "warehouse", enabled: 1, is_required: 1, status: "not_started" },
];

describe("configured order business target", () => {
  it("follows a frozen module moved ahead of the canonical sequence", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules,
      currentStepKey: "task_assignment",
      placements: [
        { step_key: "custom_warehouse_first", sort_order: 45, module_code: "warehouse", module_required: 1, module_state_status: "pending" },
        { step_key: "port_loading", sort_order: 70, module_code: "transport", module_required: 1, module_state_status: "pending" },
      ],
    }).stepKey).toBe("custom_warehouse_first");
  });

  it("advances to the moved transport node after warehouse completion", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules: [
        { ...modules[0], status: "not_started" },
        { ...modules[1], status: "completed" },
      ],
      currentStepKey: "custom_warehouse_first",
      placements: [
        { step_key: "custom_warehouse_first", sort_order: 45, module_code: "warehouse", module_required: 1, module_state_status: "completed" },
        { step_key: "port_loading", sort_order: 70, module_code: "transport", module_required: 1, module_state_status: "pending" },
      ],
    }).stepKey).toBe("port_loading");
  });

  it("allows the status-driven core consignment repeats and advances to execution work", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules: [
        { module_code: "consignment", enabled: 1, is_required: 1, status: "completed" },
        modules[0],
      ],
      currentStepKey: "task_assignment",
      placements: [
        { step_key: "quotation", sort_order: 10, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "order_creation", sort_order: 20, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "consignment_approval", sort_order: 30, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "domestic_execution", sort_order: 50, module_code: "transport", module_required: 1, module_state_status: "pending" },
      ],
    })).toEqual({
      stepKey: "domestic_execution",
      unresolvedModuleCodes: [],
    });
  });

  it("fails closed when required consignment is repeated outside the core status-driven nodes", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules: [
        { module_code: "consignment", enabled: 1, is_required: 1, status: "completed" },
        modules[0],
      ],
      currentStepKey: "task_assignment",
      placements: [
        { step_key: "quotation", sort_order: 10, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "order_creation", sort_order: 20, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "consignment_approval", sort_order: 30, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "custom_consignment_check", sort_order: 40, module_code: "consignment", module_required: 1, module_state_status: "pending" },
        { step_key: "domestic_execution", sort_order: 50, module_code: "transport", module_required: 1, module_state_status: "pending" },
      ],
    })).toEqual({
      stepKey: "task_assignment",
      unresolvedModuleCodes: ["consignment"],
    });
  });

  it("fails closed when the repeated core consignment placement is incomplete", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules: [
        { module_code: "consignment", enabled: 1, is_required: 1, status: "completed" },
        modules[0],
      ],
      currentStepKey: "order_creation",
      placements: [
        { step_key: "quotation", sort_order: 10, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "order_creation", sort_order: 20, module_code: "consignment", module_required: 1, module_state_status: "completed" },
        { step_key: "domestic_execution", sort_order: 50, module_code: "transport", module_required: 1, module_state_status: "pending" },
      ],
    })).toEqual({
      stepKey: "order_creation",
      unresolvedModuleCodes: ["consignment"],
    });
  });

  it("fails closed when a frozen module has more than one required occurrence", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules: [modules[0]],
      currentStepKey: "transport_prepare",
      placements: [
        { step_key: "transport_prepare", sort_order: 50, module_code: "transport", module_required: 1, module_state_status: "completed" },
        { step_key: "transport_confirm", sort_order: 60, module_code: "transport", module_required: 1, module_state_status: "pending" },
      ],
    })).toEqual({
      stepKey: "transport_prepare",
      unresolvedModuleCodes: ["transport"],
    });
  });

  it("fails closed at the current node when a pending module has no frozen placement", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules,
      currentStepKey: "task_assignment",
      placements: [
        { step_key: "warehouse_receiving", sort_order: 60, module_code: "warehouse", module_required: 1, module_state_status: "pending" },
      ],
    })).toEqual({
      stepKey: "task_assignment",
      unresolvedModuleCodes: ["transport"],
    });
  });

  it("targets completion review when all required modules are complete", () => {
    expect(resolveConfiguredOrderBusinessTarget({
      modules: modules.map((module) => ({ ...module, status: "completed" })),
      currentStepKey: "reconciliation",
      placements: [],
    })).toEqual({ stepKey: "completion_review", unresolvedModuleCodes: [] });
  });
});
