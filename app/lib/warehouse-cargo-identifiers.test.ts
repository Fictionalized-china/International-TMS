import { describe, expect, it } from "vitest";
import { resolveWarehouseCargoIdentifiers } from "./warehouse-cargo-identifiers";

const packages = [
  {
    id: "package-1",
    order_id: "order-1",
    cargo_item_id: "cargo-1",
    package_number: "PK-001",
    barcode: "OUL-ABC-001",
    status: "in_stock",
  },
];

describe("warehouse cargo identifiers", () => {
  it("always uses the order number as the generated mark number", () => {
    const result = resolveWarehouseCargoIdentifiers({
      orderNumber: "SO2026090200220",
      cargoItemId: "cargo-1",
      customMarks: null,
      packages,
      singleCargoItem: true,
    });

    expect(result.markNumber).toBe("SO2026090200220");
    expect(result.customMarks).toBeNull();
    expect(result.packages.map((item) => item.barcode)).toEqual(["OUL-ABC-001"]);
  });

  it("falls back to an unlinked legacy package for a single cargo line", () => {
    const result = resolveWarehouseCargoIdentifiers({
      orderNumber: "SO-LEGACY",
      cargoItemId: "cargo-legacy",
      customMarks: "向上",
      packages: [{ ...packages[0], cargo_item_id: null }],
      singleCargoItem: true,
    });

    expect(result.customMarks).toBe("向上");
    expect(result.packages[0].barcode).toBe("OUL-ABC-001");
  });
});
