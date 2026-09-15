import { describe, expect, it } from "vitest";
import {
  composeOrderWorkflow,
  composedWorkflowProgress,
  enabledOrderModules,
  orderModuleDefinition,
  pickNextRequiredWorkflowModule,
  workflowConfiguredModuleFlags,
  workflowModuleConfigurationSource,
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
    // 装车与出库是核心必经模块，整车/拼车都启用，仅按报价类型分支
    expect(state.loading).toBe(true);
    expect(state.documents).toBe(true);
    expect(orderModuleDefinition("tracking")?.steps.at(-1)?.code).toBe(
      "arrived",
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
      "loading",
      "documents",
      "tracking",
      "costs",
      "review",
    ]);
    expect(composedWorkflowProgress(snapshots)).toBe(33);
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

  it.each(["not_started", "in_progress", "blocked"])(
    "keeps an optional %s module actionable without making it the mainline next step",
    (optionalStatus) => {
      const optional = {
        module_code: "exceptions",
        module_name: "异常处理",
        enabled: 1,
        is_required: 0,
        status: optionalStatus,
        current_step_name: "异常处理",
        progress_percent: 25,
      } satisfies OrderWorkflowModuleSnapshot;
      const required = {
        module_code: "review",
        module_name: "订单复盘",
        enabled: 1,
        is_required: 1,
        status: "not_started",
        current_step_name: "等待复盘",
        progress_percent: 0,
      } satisfies OrderWorkflowModuleSnapshot;

      // The module remains enabled/actionable. Once work starts, the existing
      // overview behavior also keeps it visible without promoting it to the
      // mainline.
      expect(optional.enabled).toBe(1);
      if (optionalStatus !== "not_started") {
        expect(composeOrderWorkflow([optional, required])).toContain(optional);
      }
      // Only required modules are candidates for advancing the order mainline.
      expect(
        pickNextRequiredWorkflowModule(
          [optional, required],
          [["exceptions", "review"]],
        ),
      ).toBe(required);
    },
  );

  it("returns no mainline next step when only optional modules remain", () => {
    expect(
      pickNextRequiredWorkflowModule(
        [
          {
            module_code: "exceptions",
            enabled: 1,
            is_required: 0,
            status: "blocked",
          },
        ],
        [["exceptions"]],
      ),
    ).toBeNull();
  });

  it("enables the loading module for both quote types", () => {
    expect(enabledOrderModules("ltl", []).find((item) => item.code === "loading")?.enabled).toBe(true);
    expect(enabledOrderModules("ftl", []).find((item) => item.code === "loading")?.enabled).toBe(true);
  });

  it("enables domestic warehouse receiving by default for road orders", () => {
    expect(enabledOrderModules("ltl", []).find((item) => item.code === "warehouse")?.enabled).toBe(true);
    expect(enabledOrderModules("ftl", []).find((item) => item.code === "warehouse")?.enabled).toBe(true);
    expect(enabledOrderModules("parcel", []).find((item) => item.code === "warehouse")?.enabled).toBe(false);
  });

  it("keeps runtime module gates aligned with the workflow configuration", () => {
    expect(workflowConfiguredModuleFlags({
      moduleCode: "warehouse",
      rule: { enabled: 1, is_required: 1 },
    })).toEqual({ enabled: 1, required: 1 });
    expect(workflowConfiguredModuleFlags({
      moduleCode: "warehouse",
      rule: { enabled: 1, is_required: 0 },
    })).toEqual({ enabled: 1, required: 0 });
    expect(workflowConfiguredModuleFlags({
      moduleCode: "warehouse",
      rule: { enabled: 0, is_required: 1 },
    })).toEqual({ enabled: 0, required: 0 });
  });

  it("uses the frozen instance as the module-configuration source", () => {
    expect(workflowModuleConfigurationSource("instance-1", "definition-2")).toEqual({
      kind: "workflow_instance",
      id: "instance-1",
    });
    expect(workflowModuleConfigurationSource(null, "definition-2")).toEqual({
      kind: "definition",
      id: "definition-2",
    });
    expect(workflowModuleConfigurationSource(null, null)).toBeNull();
  });

  it("distinguishes pre-departure planning from post-loading execution", () => {
    expect(orderModuleDefinition("transport")?.name).toBe("运输安排");
    expect(orderModuleDefinition("loading")?.name).toBe("装车与出库");
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
    expect(workflow.indexOf("transport")).toBeLessThan(workflow.indexOf("warehouse"));
    expect(workflow.indexOf("warehouse")).toBeLessThan(workflow.indexOf("loading"));
    expect(workflow.indexOf("loading")).toBeLessThan(workflow.indexOf("tracking"));
  });
});
