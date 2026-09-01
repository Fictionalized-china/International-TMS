import { describe, expect, it } from "vitest";
import { domesticTransportPayableWorkflowValues } from "./transport-workflow";

describe("domestic transport workflow facts", () => {
  it("maps the payable expense created with a transport assignment to its workflow gates", () => {
    expect(domesticTransportPayableWorkflowValues({
      charge_name: "国内汽运费",
      quantity: 1,
      exchange_rate: 1,
    })).toEqual({
      domestic_payable_charge_name: "国内汽运费",
      domestic_payable_quantity: 1,
      domestic_payable_exchange_rate: 1,
    });
  });

  it("keeps missing payable facts empty instead of inventing completion data", () => {
    expect(domesticTransportPayableWorkflowValues(null)).toEqual({
      domestic_payable_charge_name: null,
      domestic_payable_quantity: null,
      domestic_payable_exchange_rate: null,
    });
  });
});
