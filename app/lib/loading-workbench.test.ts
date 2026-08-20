import { describe, expect, it } from "vitest";
import {
  buildLoadingFilter,
  loadingCompatibilityKey,
  loadingRouteKey,
  summarizeLoadingSelection,
} from "./loading-workbench";

describe("loading workbench", () => {
  it("normalizes a route identity", () => {
    expect(
      loadingRouteKey({
        origin_country: " CN ",
        origin_state: "Guangdong",
        origin_city: "Shenzhen",
        destination_country: "UZ",
        destination_state: null,
        destination_city: "Tashkent",
      }),
    ).toBe("cn|guangdong|shenzhen>uz||tashkent");
  });

  it("includes the mandatory loading decisions in the compatibility key", () => {
    expect(
      loadingCompatibilityKey({
        origin_country: "CN",
        origin_state: "Xinjiang",
        origin_city: "Urumqi",
        destination_country: "UZ",
        destination_state: null,
        destination_city: "Tashkent",
        exit_port: "CN-XJ-KH",
        customs_location: "CN-XJ-KH-CUSTOMS",
        domestic_warehouse_id: "WH-CN-01",
        overseas_warehouse_id: "WH-UZ-01",
      }),
    ).toBe(
      "cn|xinjiang|urumqi>uz||tashkent|cn-xj-kh|cn-xj-kh-customs|wh-cn-01|wh-uz-01",
    );
  });

  it("builds escaped contains filters", () => {
    expect(
      buildLoadingFilter({
        field: "customer",
        operator: "contains",
        value: "ACME%",
      }),
    ).toEqual({
      clause: "LOWER(COALESCE(customer_name,'')) LIKE ? ESCAPE '\\'",
      bindings: ["%acme\\%%"],
    });
  });

  it("builds existence filters without a value", () => {
    expect(
      buildLoadingFilter({
        field: "warehouse",
        operator: "not_exists",
        value: "",
      }),
    ).toEqual({
      clause: "COALESCE(TRIM(warehouse_name),'')=''",
      bindings: [],
    });
  });

  it("summarizes the fixed current order and checked candidates", () => {
    expect(
      summarizeLoadingSelection(
        { pieces: 2, gross_weight_kg: 100, volume_cbm: 1.2 },
        [
          { id: "b", pieces: 3, gross_weight_kg: 80, volume_cbm: 0.8 },
          { id: "c", pieces: 5, gross_weight_kg: 120, volume_cbm: 1.5 },
        ],
        ["b", "c"],
      ),
    ).toEqual({
      orderCount: 3,
      pieces: 10,
      weight: 300,
      volume: 3.5,
    });
  });
});
