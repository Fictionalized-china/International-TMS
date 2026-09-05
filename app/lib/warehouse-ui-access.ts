export type WarehouseUiAccessUser = {
  permissions: readonly string[];
};

/** Mirrors the server-side permission plus per-warehouse access-level gate. */
export function canOperateWarehouseUi(
  user: WarehouseUiAccessUser,
  warehouseAccessLevel: string,
) {
  return user.permissions.includes("warehouse.operate") && (
    user.permissions.includes("warehouse.manage") ||
    warehouseAccessLevel === "operator" ||
    warehouseAccessLevel === "manager"
  );
}
