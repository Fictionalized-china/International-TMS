import { describe, expect, it, vi } from "vitest";
import { loadWorkflowFieldGroups, loadWorkflowPlacementBlockers } from "./workflow-field-read-batch";
import type { OrderModuleCode } from "./order-modules";

const field = (stepKey: string, overrides = {}) => ({
  stepKey, isActive: true, isRequired: true, present: false, ...overrides,
});

describe("workflow field read batches", () => {
  it("loads each module once while preserving its distinct per-step gates", async () => {
    const load = vi.fn(async () => [
      field("creation", { present: true }), field("settlement"),
      field("optional", { isRequired: false }), field("hidden", { isActive: false }),
    ]);
    const blockers = await loadWorkflowPlacementBlockers([
      { id: "early", step_key: "creation", module_code: "costs" },
      { id: "late", step_key: "settlement", module_code: "costs" },
      { id: "optional", step_key: "optional", module_code: "costs" },
      { id: "hidden", step_key: "hidden", module_code: "costs" },
    ], load);
    expect([...blockers]).toEqual(["late"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds parallel work instead of filling the database queue", async () => {
    let active = 0, maximum = 0;
    const load = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return [];
    });
    const codes: OrderModuleCode[] = ["cargo", "costs", "transport", "warehouse", "loading", "tracking", "cargo"];
    const groups = await loadWorkflowFieldGroups(codes, load);
    expect([...groups.keys()]).toEqual([...new Set(codes)]);
    expect(load).toHaveBeenCalledTimes(6);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(3);
  });

  it("does not share values across invocations, orders, configuration changes or retries", async () => {
    const load = vi.fn(async () => [field("settlement")]);
    const placements = [{ id: "costs", step_key: "settlement", module_code: "costs" }];
    expect([...await loadWorkflowPlacementBlockers(placements, load)]).toEqual(["costs"]);
    load.mockImplementation(async () => [field("settlement", { present: true })]);
    expect([...await loadWorkflowPlacementBlockers(placements, load)]).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails closed if any field read fails instead of treating that gate as complete", async () => {
    await expect(loadWorkflowPlacementBlockers([
      { id: "cargo", step_key: "creation", module_code: "cargo" },
    ], async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
  });

  it("does no work for an empty module selection", async () => {
    const load = vi.fn(async () => []);
    expect((await loadWorkflowFieldGroups([], load)).size).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
});
