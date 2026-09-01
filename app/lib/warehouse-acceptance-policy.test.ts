import { describe, expect, it } from "vitest";
import {
  automaticWarehouseAcceptanceResult,
  resolveWarehouseAcceptancePolicies,
  warehouseAcceptancePackageCount,
  warehouseAcceptanceReadyIsBlocked,
} from "./warehouse-acceptance-policy";

describe("resolveWarehouseAcceptancePolicies", () => {
  it("uses the current order instance modes for configurable receipt fields", () => {
    const policies = resolveWarehouseAcceptancePolicies([
      { fieldKey: "actual_package_count", isActive: false, isRequired: false },
      { fieldKey: "actual_pieces", isActive: true, isRequired: false },
      { fieldKey: "actual_weight_kg", isActive: false, isRequired: false },
      { fieldKey: "warehouse_location", isActive: true, isRequired: false },
      { fieldKey: "cargo_complete_set", isActive: false, isRequired: false },
      { fieldKey: "receipt_evidence", isActive: true, isRequired: true },
      { fieldKey: "warehouse_receipt_notes", isActive: false, isRequired: false },
    ]);

    expect(policies.actualPackages).toMatchObject({ isActive: false, isRequired: false });
    expect(policies.actualPieces).toMatchObject({ isActive: true, isRequired: false });
    expect(policies.actualWeight).toMatchObject({ isActive: false, isRequired: false });
    expect(policies.location).toMatchObject({ isActive: true, isRequired: false });
    expect(policies.cargoComplete).toMatchObject({ isActive: false, isRequired: false });
    expect(policies.evidence).toMatchObject({ isActive: true, isRequired: true });
    expect(policies.notes).toMatchObject({ isActive: false, isRequired: false });
  });

  it("keeps dimensions structurally required while package count follows the instance", () => {
    const policies = resolveWarehouseAcceptancePolicies([]);

    expect(policies.actualPackages).toMatchObject({
      isActive: true,
      isRequired: true,
      isSystemLocked: false,
    });
    expect(policies.actualDimensions).toEqual({
      isActive: true,
      isRequired: true,
      isSystemLocked: true,
    });
  });

  it("derives omitted package count from planned minus cumulative receipt and never goes negative", () => {
    expect(warehouseAcceptancePackageCount({
      plannedPackages: 8,
      receivedPackages: 3,
      submittedPackages: null,
    })).toBe(5);
    expect(warehouseAcceptancePackageCount({
      plannedPackages: 3,
      receivedPackages: 8,
      submittedPackages: null,
    })).toBe(0);
    expect(warehouseAcceptancePackageCount({
      plannedPackages: 8,
      receivedPackages: 3,
      submittedPackages: 7,
    })).toBe(7);
  });

  it("falls back to the catalog defaults for legacy instances without snapshots", () => {
    const policies = resolveWarehouseAcceptancePolicies([]);

    expect(policies.actualPieces).toMatchObject({ isActive: true, isRequired: true });
    expect(policies.actualWeight).toMatchObject({ isActive: true, isRequired: true });
    expect(policies.actualVolume).toMatchObject({ isActive: true, isRequired: true });
    expect(policies.location).toMatchObject({ isActive: true, isRequired: true });
    expect(policies.cargoComplete).toMatchObject({ isActive: true, isRequired: true });
    expect(policies.evidence).toMatchObject({ isActive: true, isRequired: false });
    expect(policies.notes).toMatchObject({ isActive: true, isRequired: false });
  });

  it("never auto-confirms over-receipt or a material comparable difference", () => {
    expect(automaticWarehouseAcceptanceResult({
      actualPackages: 3,
      expectedPackages: 2,
      piecesMismatch: false,
      requiresFeeConfirmation: false,
    })).toBe("exception");
    expect(automaticWarehouseAcceptanceResult({
      actualPackages: 2,
      expectedPackages: 2,
      piecesMismatch: false,
      requiresFeeConfirmation: true,
    })).toBe("exception");
  });

  it("auto-confirms only an exact package count without a comparable blocking difference", () => {
    const exact = {
      actualPackages: 2,
      expectedPackages: 2,
      piecesMismatch: false,
      requiresFeeConfirmation: false,
    };
    expect(automaticWarehouseAcceptanceResult(exact)).toBe("ready");
    expect(warehouseAcceptanceReadyIsBlocked(exact)).toBe(false);
    expect(automaticWarehouseAcceptanceResult({ ...exact, actualPackages: 1 })).toBe("partial");
    expect(warehouseAcceptanceReadyIsBlocked({ ...exact, actualPackages: 1 })).toBe(true);
  });
});
