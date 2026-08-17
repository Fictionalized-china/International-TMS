export const customerBusinessRoles = [
  { code: "overseas_agent", label: "国外代理" },
  { code: "fee_party", label: "费用关系人" },
  { code: "principal", label: "委托人" },
  { code: "shipper", label: "发货人" },
  { code: "consignee", label: "收货人" },
  { code: "notify_party", label: "通知人" },
  { code: "trucking", label: "拖车" },
  { code: "shipping_agent", label: "船代" },
  { code: "factory", label: "工厂" },
  { code: "booking_party", label: "订舱约号单位" },
  { code: "warehouse", label: "仓库" },
  { code: "customs_broker", label: "报关行" },
  { code: "ro_agent", label: "RO代理" },
  { code: "intermediary", label: "中间商" },
  { code: "container_owner", label: "箱主" },
  { code: "freight_station", label: "货站/物流园" },
  { code: "yard", label: "堆场" },
] as const;

export type CustomerBusinessRoleCode = (typeof customerBusinessRoles)[number]["code"];

const roleCodeSet = new Set<string>(customerBusinessRoles.map((item) => item.code));

export function isCustomerBusinessRoleCode(value: string): value is CustomerBusinessRoleCode {
  return roleCodeSet.has(value);
}

export function customerBusinessRoleLabel(code: string) {
  return customerBusinessRoles.find((item) => item.code === code)?.label ?? code;
}

export function legacyCustomerTypeForRoles(roles: CustomerBusinessRoleCode[]) {
  if (roles.includes("overseas_agent") || roles.includes("intermediary")) return "agent";
  if (roles.includes("fee_party")) return "partner";
  return "direct";
}
