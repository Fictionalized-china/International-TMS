import { describe, expect, it } from "vitest";
import {
  cargoEditorFieldPolicy,
  nextOrderPackageCodeSequence,
  resolveCargoEditorSubmission,
  type CargoEditorRecord,
} from "./order-cargo-editor";

const existing: CargoEditorRecord = {
  cargoName: "旧品名",
  cargoNameEn: "Old cargo",
  hsCode: "OLD-HS",
  overseasHsCode: "",
  packageType: "pallet",
  packageCount: 2,
  piecesPerPackage: 3,
  weight: 20,
  netWeight: 18,
  length: 100,
  width: 80,
  height: 60,
  volume: 0.48,
  declaredValue: 1000,
  currency: "USD",
  originCountry: "CN",
  brandModel: "M1",
  marks: "MARK",
  specialAttributes: "fragile",
  notes: "old",
};

describe("order cargo editor workflow policy", () => {
  it("ignores forged values for hidden fields while preserving an existing row", () => {
    const result = resolveCargoEditorSubmission({
      fields: [
        { fieldKey: "cargo_name_cn", label: "中文品名", isActive: true, isRequired: true },
        { fieldKey: "hs_code", label: "HS Code", isActive: false, isRequired: false },
      ],
      existing,
      submitted: { cargoName: "新品名", hsCode: "FORGED-HS" },
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.value.cargoName).toBe("新品名");
      expect(result.value.hsCode).toBe("OLD-HS");
    }
  });

  it("rejects a missing required field from the frozen snapshot", () => {
    const result = resolveCargoEditorSubmission({
      fields: [{ fieldKey: "cargo_name_cn", label: "中文品名", isActive: true, isRequired: true }],
      submitted: { cargoName: "" },
    });
    expect(result).toEqual({ ok: false, error: "请填写中文品名" });
  });

  it("computes required volume from visible dimensions", () => {
    const fields = [
      { fieldKey: "cargo_name_cn", isActive: true, isRequired: true },
      { fieldKey: "package_type", isActive: true, isRequired: true },
      { fieldKey: "package_count", isActive: true, isRequired: true },
      { fieldKey: "pieces_per_package", isActive: true, isRequired: true },
      { fieldKey: "gross_weight_per_package_kg", isActive: true, isRequired: true },
      { fieldKey: "length_cm", isActive: true, isRequired: false },
      { fieldKey: "width_cm", isActive: true, isRequired: false },
      { fieldKey: "height_cm", isActive: true, isRequired: false },
      { fieldKey: "volume_per_package_cbm", isActive: true, isRequired: true },
    ];
    const result = resolveCargoEditorSubmission({
      fields,
      submitted: {
        cargoName: "测试货物",
        packageType: "carton",
        packageCount: "2",
        piecesPerPackage: "1",
        weight: "12",
        length: "100",
        width: "80",
        height: "50",
        volume: "0",
      },
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) expect(result.value.volume).toBeCloseTo(0.4);
  });

  it("keeps catalog defaults only for a truly legacy empty snapshot", () => {
    expect(cargoEditorFieldPolicy([], "cargo_name_cn")).toMatchObject({ visible: true, required: true });
    expect(cargoEditorFieldPolicy([], "cargo_name_en")).toMatchObject({ visible: true, required: false });
  });

  it("allocates a package code after the highest historical suffix instead of COUNT", () => {
    expect(nextOrderPackageCodeSequence("SO-001", [
      "SO-001-P001",
      "SO-001-P003",
      "SO-OTHER-P099",
    ])).toBe(4);
  });
});
