import { describe, expect, it } from "vitest";

import {
  isExplicitDispatchCreationConfirmation,
  resolveWarehouseOutboundWorkflowPolicy,
  resolveWarehouseOutboundWorkflowPolicyForOrders,
} from "./warehouse-outbound-policy";

const field = (
  fieldKey: string,
  mode: "required" | "optional" | "hidden",
) => ({
  fieldKey,
  isActive: mode !== "hidden",
  isRequired: mode === "required",
});

describe("resolveWarehouseOutboundWorkflowPolicy", () => {
  it("requires the dedicated operator confirmation value before creating a dispatch", () => {
    expect(isExplicitDispatchCreationConfirmation("confirm_dispatch_creation")).toBe(true);
    expect(isExplicitDispatchCreationConfirmation(null)).toBe(false);
    expect(isExplicitDispatchCreationConfirmation("create")).toBe(false);
  });

  it("lets any required order make the whole PZ field required", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicy([
      [field("loading_handover_notes", "hidden"), field("loading_scan_confirmation", "optional")],
      [field("loading_handover_notes", "required"), field("loading_scan_confirmation", "required")],
    ]);

    expect(policy.handoverNotes).toEqual({
      isActive: true,
      isRequired: true,
      mode: "required",
    });
    expect(policy.scanConfirmation).toEqual({
      isActive: true,
      isRequired: true,
      mode: "required",
    });
  });

  it("keeps a field visible when at least one order is optional", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicy([
      [field("loading_handover_notes", "hidden"), field("loading_scan_confirmation", "hidden")],
      [field("loading_handover_notes", "optional"), field("loading_scan_confirmation", "optional")],
    ]);

    expect(policy.handoverNotes.mode).toBe("optional");
    expect(policy.scanConfirmation.mode).toBe("optional");
  });

  it("hides a field only when every attached order hides it", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicy([
      [field("loading_handover_notes", "hidden"), field("loading_scan_confirmation", "hidden")],
      [field("loading_handover_notes", "hidden"), field("loading_scan_confirmation", "hidden")],
    ]);

    expect(policy.handoverNotes.mode).toBe("hidden");
    expect(policy.scanConfirmation.mode).toBe("hidden");
  });

  it("uses safe legacy fallbacks when no order policy is available", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicy([]);

    expect(policy.handoverNotes.mode).toBe("optional");
    expect(policy.scanConfirmation.mode).toBe("required");
  });

  it("does not reopen loading gates after every attached order passed the stage", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicyForOrders([
      {
        orderId: "order-past-loading",
        appliesToCurrentOrFuture: false,
        fields: [
          field("loading_handover_notes", "required"),
          field("loading_scan_confirmation", "required"),
        ],
      },
    ]);

    expect(policy.handoverNotes.mode).toBe("hidden");
    expect(policy.scanConfirmation.mode).toBe("hidden");
  });

  it("uses only current or future orders when a batch mixes workflow stages", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicyForOrders([
      {
        orderId: "order-past-loading",
        appliesToCurrentOrFuture: false,
        fields: [field("loading_scan_confirmation", "required")],
      },
      {
        orderId: "order-at-loading",
        appliesToCurrentOrFuture: true,
        fields: [
          field("loading_handover_notes", "optional"),
          field("loading_scan_confirmation", "hidden"),
        ],
      },
    ]);

    expect(policy.handoverNotes.mode).toBe("optional");
    expect(policy.scanConfirmation.mode).toBe("hidden");
  });

  it("treats fields absent from a frozen loading node as hidden", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicyForOrders([{
      orderId: "frozen-order",
      usesFrozenSnapshot: true,
      appliesToCurrentOrFuture: true,
      loadingStageAvailable: true,
      fields: [],
    }]);

    expect(policy.handoverNotes.mode).toBe("hidden");
    expect(policy.scanConfirmation.mode).toBe("hidden");
  });

  it("uses catalog fallbacks only for an explicitly legacy SQL-NULL binding", () => {
    const policy = resolveWarehouseOutboundWorkflowPolicyForOrders([{
      orderId: "legacy-order",
      usesFrozenSnapshot: false,
      appliesToCurrentOrFuture: true,
      loadingStageAvailable: true,
      fields: [],
    }]);

    expect(policy.handoverNotes.mode).toBe("optional");
    expect(policy.scanConfirmation.mode).toBe("required");
  });
});
