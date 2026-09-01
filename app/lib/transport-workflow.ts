export type DomesticTransportPayable = {
  charge_name: string | null;
  quantity: number | null;
  exchange_rate: number | null;
};

export function domesticTransportPayableWorkflowValues(
  payable: DomesticTransportPayable | null | undefined,
) {
  return {
    domestic_payable_charge_name: payable?.charge_name ?? null,
    domestic_payable_quantity: payable?.quantity ?? null,
    domestic_payable_exchange_rate: payable?.exchange_rate ?? null,
  };
}
