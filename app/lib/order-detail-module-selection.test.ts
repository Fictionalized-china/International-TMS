import { describe, expect, it } from "vitest";
import {
  enabledWorkflowModuleCodes,
  resolveEmbeddedWorkflowModuleCode,
} from "./order-detail-module-selection";

describe("order detail embedded module selection", () => {
  it("skips a disabled module before the enabled current modules", () => {
    const codes = enabledWorkflowModuleCodes([
      { step_key: "outbound_transport", module_code: "documents", module_enabled: 0 },
      { step_key: "outbound_transport", module_code: "customs", module_enabled: 1 },
      { step_key: "outbound_transport", module_code: "tracking", module_enabled: 1 },
      { step_key: "settlement", module_code: "costs", module_enabled: 1 },
    ], "outbound_transport");

    expect(codes).toEqual(["customs", "tracking"]);
    expect(resolveEmbeddedWorkflowModuleCode({
      requestedModuleCode: null,
      enabledModuleCodes: codes,
    })).toBe("customs");
  });

  it("does not embed a requested module disabled in the frozen order instance", () => {
    const codes = enabledWorkflowModuleCodes([
      { step_key: "outbound_transport", module_code: "documents", module_enabled: 0 },
      { step_key: "outbound_transport", module_code: "customs", module_enabled: 1 },
    ], "outbound_transport");

    expect(resolveEmbeddedWorkflowModuleCode({
      requestedModuleCode: "documents",
      enabledModuleCodes: codes,
    })).toBe("customs");
  });

  it("deduplicates task rows without changing frozen module order", () => {
    expect(enabledWorkflowModuleCodes([
      { step_key: "domestic_transport", module_code: "transport", module_enabled: 1 },
      { step_key: "domestic_transport", module_code: "transport", module_enabled: 1 },
      { step_key: "domestic_transport", module_code: null, module_enabled: null },
    ], "domestic_transport")).toEqual(["transport"]);
  });

  it("returns no embedded module when the configured step has no enabled module", () => {
    expect(resolveEmbeddedWorkflowModuleCode({
      requestedModuleCode: "documents",
      enabledModuleCodes: [],
    })).toBeNull();
  });
});
