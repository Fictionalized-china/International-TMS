import { isBossBusinessActor } from "./permission-blocks";

export type WarehouseAccessActor = {
  positionCode: string | null;
  roleCodes: readonly string[];
  permissions: readonly string[];
};

export type WarehouseAccessAssignment = {
  warehouse_id: string;
  access_level: string;
};

export function resolveWarehouseAccess(
  user: WarehouseAccessActor,
  rows: readonly WarehouseAccessAssignment[],
) {
  if (isBossBusinessActor(user))
    return { all: true, warehouseIds: [] as string[], levels: new Map<string, string>() };
  // An explicit warehouse assignment wins even for managers. This keeps the
  // warehouse workspace tied to the signed-in account instead of silently
  // falling back to the first warehouse in the organization.
  if (rows.length)
    return {
      all: false,
      warehouseIds: rows.map((row) => row.warehouse_id),
      levels: new Map(rows.map((row) => [row.warehouse_id, row.access_level])),
    };
  if (user.permissions.includes("warehouse.manage"))
    return { all: true, warehouseIds: [] as string[], levels: new Map<string, string>() };
  return { all: false, warehouseIds: [] as string[], levels: new Map<string, string>() };
}
