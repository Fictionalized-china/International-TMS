export const warehouseRoles = [
  "domestic_collection",
  "port",
  "overseas_destination",
] as const;

export type WarehouseRole = (typeof warehouseRoles)[number];

export const warehouseRoleLabels: Record<WarehouseRole, string> = {
  domestic_collection: "国内集货仓",
  port: "口岸仓",
  overseas_destination: "境外目的仓",
};

export type DefaultWarehouseZone = {
  code: string;
  name: string;
  type: "receiving" | "storage" | "sorting" | "staging" | "exception" | "dispatch";
  locationCode: string;
  locationName: string;
};

const domesticZones: DefaultWarehouseZone[] = [
  { code: "RCV", name: "收货区", type: "receiving", locationCode: "RCV-01", locationName: "收货暂存位" },
  { code: "LOAD", name: "待配载区", type: "staging", locationCode: "LOAD-01", locationName: "待配载暂存位" },
  { code: "DSP", name: "发货区", type: "dispatch", locationCode: "DSP-01", locationName: "发货暂存位" },
];

const overseasZones: DefaultWarehouseZone[] = [
  { code: "ARR", name: "到仓区", type: "receiving", locationCode: "ARR-01", locationName: "到仓暂存位" },
  { code: "PICK", name: "待提货区", type: "storage", locationCode: "PICK-01", locationName: "待提货库位" },
  { code: "RSV", name: "已预约区", type: "staging", locationCode: "RSV-01", locationName: "预约提货暂存位" },
  { code: "EXC", name: "异常区", type: "exception", locationCode: "EXC-01", locationName: "异常暂存位" },
];

export function isWarehouseRole(value: string): value is WarehouseRole {
  return warehouseRoles.includes(value as WarehouseRole);
}

export function defaultZonesForRole(role: WarehouseRole) {
  return role === "overseas_destination" ? overseasZones : domesticZones;
}

export function isCollectionWarehouseRole(role: string) {
  return role === "domestic_collection" || role === "port";
}
