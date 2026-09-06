import { beforeEach, describe, expect, it, vi } from "vitest";

type ConfigRow = {
  workflow_instance_id: string | null;
  matched_instance_id: string | null;
  matched_instance_status: string | null;
  module_enabled: number;
  module_required: number;
};

const harness = vi.hoisted(() => {
  const state = {
    configByOrder: new Map<string, ConfigRow>(),
    fieldsByOrder: new Map<string, Array<Record<string, unknown>>>(),
    contextByOrder: new Map<string, Record<string, unknown>>(),
    clearedOrderIds: new Set<string>(),
  };
  const queries: Array<{ sql: string; bindings: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] };
      queries.push(call);
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return statement;
        },
        async first<T>() {
          if (sql.includes("matched_instance_status")) {
            return (state.configByOrder.get(String(call.bindings[1])) ?? null) as T | null;
          }
          return null;
        },
        async all<T>() {
          if (sql.includes("FROM order_tracking_milestones")) {
            return {
              results: [...state.clearedOrderIds]
                .filter((orderId) => call.bindings.includes(orderId))
                .map((order_id) => ({ order_id })) as T[],
            };
          }
          return { results: [] as T[] };
        },
      };
      return statement;
    },
  };
  return {
    state,
    queries,
    DB,
    loadFields: vi.fn(async (_organizationId: string, orderId: string) =>
      state.fieldsByOrder.get(orderId) ?? []),
    loadContext: vi.fn(async (_db: unknown, _organizationId: string, orderId: string) =>
      state.contextByOrder.get(orderId) ?? {
        locked: false,
        currentStepKey: null,
        steps: [],
        modulePlacements: [],
        fields: [],
      }),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("./workflow-fields.server", () => ({
  loadOrderModuleWorkflowFields: harness.loadFields,
}));
vi.mock("./workflow-instance-stage-gate.server", () => ({
  loadLockedWorkflowStageContext: harness.loadContext,
}));

import { frozenWorkflowFieldScopeMarkerKey } from "./workflow-field-runtime";
import { loadOverseasInboundCustomsGates } from "./overseas-inbound-policy.server";

const activeRelease = (stepKey = "destination_clearance") => ({
  id: `release-${stepKey}`,
  workflowId: "workflow-1",
  stepKey,
  stepName: stepKey,
  moduleCode: "customs",
  fieldKey: "customs_release",
  label: "目的地海关放行",
  fieldType: "datetime",
  isRequired: true,
  isActive: true,
  mode: "required",
  sortOrder: 10,
  optionsText: null,
  helpText: null,
  isBuiltIn: true,
  present: false,
  displayValue: null,
});

function config(overrides: Partial<ConfigRow> = {}): ConfigRow {
  return {
    workflow_instance_id: "instance-1",
    matched_instance_id: "instance-1",
    matched_instance_status: "active",
    module_enabled: 1,
    module_required: 1,
    ...overrides,
  };
}

function context(currentSort: number, releaseSort: number) {
  const currentStepKey = currentSort === releaseSort ? "destination_clearance" : "overseas_pickup";
  return {
    locked: true,
    currentStepKey,
    steps: [
      { stepKey: currentStepKey, stepName: "境外仓与自提", sortOrder: currentSort },
      ...(currentStepKey === "destination_clearance" ? [] : [{
        stepKey: "destination_clearance",
        stepName: "目的地清关",
        sortOrder: releaseSort,
      }]),
    ],
    modulePlacements: [{ moduleCode: "customs", stepKey: "destination_clearance" }],
    fields: [{
      moduleCode: "customs",
      fieldKey: "customs_release",
      stepKey: "destination_clearance",
      isActive: true,
      isRequired: true,
    }],
  };
}

describe("overseas inbound customs gate server policy", () => {
  beforeEach(() => {
    harness.state.configByOrder.clear();
    harness.state.fieldsByOrder.clear();
    harness.state.contextByOrder.clear();
    harness.state.clearedOrderIds.clear();
    harness.queries.length = 0;
    vi.clearAllMocks();
  });

  it("blocks a reached required release field and reports its frozen label and node", async () => {
    harness.state.configByOrder.set("order-1", config());
    harness.state.fieldsByOrder.set("order-1", [activeRelease()]);
    harness.state.contextByOrder.set("order-1", context(80, 70));

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-001",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({
      orderId: "order-1",
      required: true,
      cleared: false,
      blocked: true,
      configurationValid: true,
      targetStepKey: "destination_clearance",
      targetStepName: "目的地清关",
    });
    expect(gate.message).toContain("SO-001");
    expect(gate.message).toContain("目的地海关放行");
    expect(gate.message).toContain("目的地清关");
  });

  it("does not pull a required release field forward from a future node", async () => {
    harness.state.configByOrder.set("order-1", config());
    harness.state.fieldsByOrder.set("order-1", [activeRelease()]);
    harness.state.contextByOrder.set("order-1", context(80, 90));

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({ required: false, cleared: false, blocked: false });
    expect(gate.message).toBeNull();
    expect(harness.queries.some((item) => item.sql.includes("order_tracking_milestones"))).toBe(false);
  });

  it.each([
    { name: "disabled module", cfg: config({ module_enabled: 0 }), fields: [activeRelease()] },
    { name: "optional module", cfg: config({ module_required: 0 }), fields: [activeRelease()] },
    { name: "hidden release", cfg: config(), fields: [{ ...activeRelease(), isActive: false, isRequired: false }] },
    { name: "optional release", cfg: config(), fields: [{ ...activeRelease(), isRequired: false, mode: "optional" }] },
    { name: "absent frozen release", cfg: config(), fields: [{
      fieldKey: frozenWorkflowFieldScopeMarkerKey,
      isActive: false,
      isRequired: false,
    }] },
  ])("keeps $name non-blocking", async ({ cfg, fields }) => {
    harness.state.configByOrder.set("order-1", cfg);
    harness.state.fieldsByOrder.set("order-1", fields);

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({ required: false, blocked: false });
  });

  it("never requires company evidence for customer-managed clearance", async () => {
    harness.state.configByOrder.set("order-1", config());

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      customsClearanceMode: "customer",
    }]);

    expect(gate).toMatchObject({ required: false, blocked: false, configurationValid: true });
    expect(harness.loadFields).not.toHaveBeenCalled();
  });

  it("retains the legacy empty-field fallback for an unbound order", async () => {
    harness.state.configByOrder.set("legacy-order", config({
      workflow_instance_id: null,
      matched_instance_id: null,
      matched_instance_status: null,
    }));

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "legacy-order",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({ required: true, cleared: false, blocked: true });
  });

  it("passes a reached required gate after the destination-clearance milestone exists", async () => {
    harness.state.configByOrder.set("order-1", config());
    harness.state.fieldsByOrder.set("order-1", [activeRelease()]);
    harness.state.contextByOrder.set("order-1", context(80, 70));
    harness.state.clearedOrderIds.add("order-1");

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({ required: true, cleared: true, blocked: false });
    const milestoneQuery = harness.queries.find((item) => item.sql.includes("order_tracking_milestones"));
    expect(milestoneQuery?.bindings).toContain("org-1");
    expect(milestoneQuery?.bindings).toContain("order-1");
  });

  it.each([
    config({ matched_instance_id: null, matched_instance_status: null }),
    config({ matched_instance_status: "completed" }),
  ])("fails closed for an invalid frozen binding", async (invalidConfig) => {
    harness.state.configByOrder.set("order-1", invalidConfig);

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-BAD",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({
      required: true,
      cleared: false,
      blocked: true,
      configurationValid: false,
    });
    expect(gate.message).toContain("冻结工作流实例无效");
    expect(harness.loadFields).not.toHaveBeenCalled();
  });

  it("fails closed when the frozen release field is duplicated", async () => {
    harness.state.configByOrder.set("order-1", config());
    harness.state.fieldsByOrder.set("order-1", [
      activeRelease("destination_clearance"),
      activeRelease("duplicate_clearance"),
    ]);

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-DUPLICATE",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({
      required: true,
      blocked: true,
      configurationValid: false,
    });
    expect(gate.message).toContain("海关放行字段重复");
    expect(harness.loadContext).not.toHaveBeenCalled();
  });

  it("fails closed when a required frozen field has no operable module placement", async () => {
    harness.state.configByOrder.set("order-1", config());
    harness.state.fieldsByOrder.set("order-1", [activeRelease()]);
    const invalidContext = context(80, 70);
    invalidContext.modulePlacements = [];
    harness.state.contextByOrder.set("order-1", invalidContext);

    const [gate] = await loadOverseasInboundCustomsGates("org-1", [{
      orderId: "order-1",
      customsClearanceMode: "company",
    }]);

    expect(gate).toMatchObject({ blocked: true, configurationValid: false });
    expect(gate.message).toContain("清关门禁配置异常");
  });
});
