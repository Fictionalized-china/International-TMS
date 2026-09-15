export type DensityMode = "compact" | "comfortable";
export type MotionMode = "on" | "off";

export function normalizeDensity(value: string | null | undefined): DensityMode {
  return value === "comfortable" ? "comfortable" : "compact";
}

export function normalizeMotion(value: string | null | undefined): MotionMode {
  return value === "off" ? "off" : "on";
}

export function nextDensity(value: DensityMode): DensityMode {
  return value === "compact" ? "comfortable" : "compact";
}

export function nextMotion(value: MotionMode): MotionMode {
  return value === "on" ? "off" : "on";
}
