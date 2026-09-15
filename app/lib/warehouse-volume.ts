const CUBIC_CENTIMETERS_PER_CUBIC_METER = 1_000_000;
const STORAGE_PRECISION = 6;
const DISPLAY_PRECISION = 4;

type WarehouseVolumeInput = {
  lengthCm: number | null | undefined;
  widthCm: number | null | undefined;
  heightCm: number | null | undefined;
  packageCount?: number | null | undefined;
};

/**
 * Calculates total CBM from the measured outer dimensions of a package.
 * Domestic receipt rows may represent multiple identical packages, while an
 * overseas barcode always identifies one physical package.
 */
export function calculateWarehouseVolumeCbm({
  lengthCm,
  widthCm,
  heightCm,
  packageCount = 1,
}: WarehouseVolumeInput): number | null {
  const measurements = [lengthCm, widthCm, heightCm, packageCount].map(Number);
  const [length, width, height, packages] = measurements;
  if (
    [length, width, height].some(
      (value) => !Number.isFinite(value) || value <= 0,
    ) ||
    !Number.isFinite(packages) ||
    packages < 0
  )
    return null;

  return Number(
    ((length * width * height * packages) / CUBIC_CENTIMETERS_PER_CUBIC_METER).toFixed(
      STORAGE_PRECISION,
    ),
  );
}

export function formatWarehouseVolumeCbm(
  value: number | null | undefined,
): string {
  return value == null || !Number.isFinite(Number(value))
    ? ""
    : Number(value).toFixed(DISPLAY_PRECISION);
}

/** Keeps the read-only volume field in a receipt row synchronized with inputs. */
export function synchronizeWarehouseVolumeRow(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const row = target.closest<HTMLElement>("[data-warehouse-volume-row]");
  if (!row) return;

  const read = (selector: string) => {
    const input = row.querySelector<HTMLInputElement>(selector);
    return input && input.value.trim() !== "" ? Number(input.value) : null;
  };
  const packageInput = row.querySelector<HTMLInputElement>(
    "[data-warehouse-volume-packages]",
  );
  const fallbackPackageCount = Number(row.dataset.warehouseVolumePackages || 1);
  const volume = calculateWarehouseVolumeCbm({
    lengthCm: read("[data-warehouse-volume-length]"),
    widthCm: read("[data-warehouse-volume-width]"),
    heightCm: read("[data-warehouse-volume-height]"),
    packageCount:
      packageInput && packageInput.value.trim() !== ""
        ? Number(packageInput.value)
        : fallbackPackageCount,
  });
  const output = row.querySelector<HTMLInputElement>(
    "[data-warehouse-volume-output]",
  );
  if (output) output.value = formatWarehouseVolumeCbm(volume);
}
