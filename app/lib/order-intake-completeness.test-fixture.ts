import type { CurrentOrderIntakeFacts } from "./order-intake-completeness";
export function completeIntakeFacts(): CurrentOrderIntakeFacts {
  return {
    order: {
      id: "order", customer_id: "customer", business_type: "ltl", transport_mode: "ROAD", salesperson_user_id: "sales", quote_commercial_user_id: "commercial",
      origin_country: "CN", origin_state: "GD", origin_city: "深圳", destination_country: "RU", destination_state: "MOW", destination_city: "莫斯科",
      exit_port: "PORT", transit_locations: "TRANSIT", customs_location: "CUSTOMS", domestic_agent: "国内代理",
      intake_operations_json: JSON.stringify({ headCarrier: "头程计划", tailCarrier: "口岸调度", headVehicleCount: 1, tailVehicleCount: 1, plannedDeparture: "2026-11-09T00:00:00.000Z", plannedArrival: "2026-11-10T00:00:00.000Z", businessAssistant: { id: "sales", display_name: "业务助理" }, customerService: { id: "cs", display_name: "客服" }, entrustedServices: ["pickup"] }),
    },
    cargo: [{ id: "cargo", declared_quantity: 2, declared_unit: "件", package_count: 1, pieces_per_package: 2, cargo_name_cn: "中文品名", gross_weight_per_package_kg: 10, volume_per_package_cbm: 0, length_cm: 0, width_cm: 0, height_cm: 0 }],
    expenses: [
      { id: "ar", direction: "receivable", stage: "estimated", charge_code: "FREIGHT", charge_name: "运费", counterparty_name: "客户", currency: "CNY", quantity: 2, unit_price: 50, amount: 100, exchange_rate: 1, base_amount: 100 },
      { id: "ap", direction: "payable", stage: "estimated", charge_code: "pickup", charge_name: "客户自送提货费", counterparty_name: "客户自送", currency: "CNY", quantity: 1, unit_price: 0, amount: 0, exchange_rate: 1, base_amount: 0 },
    ],
    services: [{ service_code: "pickup", status: "requested" }],
  };
}
