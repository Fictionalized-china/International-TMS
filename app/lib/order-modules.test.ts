import { describe, expect, it } from "vitest";
import {
  composeOrderWorkflow,
  composedWorkflowProgress,
  enabledOrderModules,
  orderModuleDefinition,
  type OrderWorkflowModuleSnapshot,
} from "./order-modules";

describe("order module activation", () => {
  it("keeps core modules enabled and activates service modules on demand", () => {
    const modules = enabledOrderModules("ltl", ["warehouse", "customs"]);
    const state = Object.fromEntries(
      modules.map((item) => [item.code, item.enabled]),
    );

    expect(state.consignment).toBe(true);
    expect(state.cargo).toBe(true);
    expect(state.assignment).toBe(true);
    expect(state.warehouse).toBe(true);
    expect(state.customs).toBe(true);
    expect(state.loading).toBe(true);
  });

  it("does not enable unrequested conditional modules", () => {
    const modules = enabledOrderModules("parcel", []);
    const state = Object.fromEntries(
      modules.map((item) => [item.code, item.enabled]),
    );

    expect(state.warehouse).toBe(false);
    expect(state.customs).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.documents).toBe(true);
    expect(orderModuleDefinition("tracking")?.steps.at(-1)?.code).toBe(
      "signed",
    );
  });

  it("composes each order workflow from enabled required modules", () => {
    const snapshots = enabledOrderModules("parcel", []).map(
      (module, index): OrderWorkflowModuleSnapshot => ({
        module_code: module.code,
        module_name: module.name,
        enabled: module.enabled ? 1 : 0,
        is_required: module.required ? 1 : 0,
        status: module.code === "exceptions" ? "not_started" : "in_progress",
        current_step_name: module.steps[0]?.name ?? null,
        progress_percent: index === 0 ? 100 : 25,
      }),
    );

    const workflow = composeOrderWorkflow(snapshots);
    expect(workflow.map((module) => module.module_code)).toEqual([
      "consignment",
      "cargo",
      "assignment",
      "transport",
      "documents",
      "tracking",
      "costs",
      "review",
    ]);
    expect(composedWorkflowProgress(snapshots)).toBe(34);
  });

  it("inserts optional exception handling only after it is activated", () => {
    const exception = {
      module_code: "exceptions",
      module_name: "异常处理",
      enabled: 1,
      is_required: 0,
      status: "processing",
      current_step_name: "异常处理",
      progress_percent: 50,
    } satisfies OrderWorkflowModuleSnapshot;

    expect(composeOrderWorkflow([exception])).toHaveLength(1);
  });

  it("uses the loading workbench for LTL only", () => {
    expect(enabledOrderModules("ltl", []).find((item) => item.code === "loading")?.enabled).toBe(true);
    expect(enabledOrderModules("ftl", []).find((item) => item.code === "loading")?.enabled).toBe(false);
  });

  it("distinguishes pre-departure planning from post-loading execution", () => {
    expect(orderModuleDefinition("transport")?.name).toBe("运输安排");
    expect(orderModuleDefinition("loading")?.name).toBe("拼车配载");
    expect(orderModuleDefinition("tracking")?.name).toBe("运输执行与跟踪");
  });

  it("places domestic transport before port loading and outbound tracking", () => {
    const snapshots = enabledOrderModules("ltl", []).map(
      (module): OrderWorkflowModuleSnapshot => ({
        module_code: module.code,
        module_name: module.name,
        enabled: module.enabled ? 1 : 0,
        is_required: module.required ? 1 : 0,
        status: "in_progress",
        current_step_name: module.steps[0]?.name ?? null,
        progress_percent: 0,
      }),
    );
    const workflow = composeOrderWorkflow(snapshots).map((item) => item.module_code);
    expect(workflow.indexOf("transport")).toBeLessThan(workflow.indexOf("loading"));
    expect(workflow.indexOf("loading")).toBeLessThan(workflow.indexOf("tracking"));
  });
});
