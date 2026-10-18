/** Legacy form values use Beijing time. MySQL DATETIME strings are UTC. */
export function storedBusinessTimestamp(value: string): number {
  let normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) normalized += "+08:00";
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) normalized = normalized.replace(" ", "T") + "Z";
  else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += "T00:00:00+08:00";
  return Date.parse(normalized);
}

export function normalizeBusinessPlanTime(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(raw)) throw new Error("计划时间格式无效");
  const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate()) throw new Error("计划日期无效");
  const instant = storedBusinessTimestamp(raw);
  if (!Number.isFinite(instant)) throw new Error("计划时间无效");
  return new Date(instant).toISOString();
}

export function businessDateTimeLabel(value: string | null | undefined): string {
  if (!value) return "";
  const timestamp = storedBusinessTimestamp(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp + 8 * 3600_000).toISOString().slice(0,16).replace("T"," ");
}
