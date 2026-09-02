export type WarehouseCargoPackageIdentifier = {
  id: string;
  order_id: string;
  cargo_item_id: string | null;
  package_number: string;
  barcode: string;
  status: string;
};

export function resolveWarehouseCargoIdentifiers(input: {
  orderNumber: string;
  cargoItemId: string;
  customMarks: string | null;
  packages: readonly WarehouseCargoPackageIdentifier[];
  singleCargoItem: boolean;
}) {
  const directlyLinked = input.packages.filter(
    (item) => item.cargo_item_id === input.cargoItemId,
  );
  const relevant = directlyLinked.length
    ? directlyLinked
    : input.singleCargoItem
      ? input.packages
      : [];
  const uniquePackages = [...new Map(
    relevant.map((item) => [item.barcode, item]),
  ).values()];

  return {
    markNumber: input.orderNumber,
    packages: uniquePackages,
    customMarks: input.customMarks?.trim() || null,
  };
}
