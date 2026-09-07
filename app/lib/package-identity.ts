export const MAX_INBOUND_PACKAGES = 500;

const PZ_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function assertPackageCount(value: number, label = "预计入仓包装数") {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INBOUND_PACKAGES) {
    throw new Error(`${label}必须是 1–${MAX_INBOUND_PACKAGES} 之间的整数`);
  }
  return value;
}

export function inboundMarkCode(orderNumber: string, sequence: number) {
  return `${orderNumber}-IN-${String(assertPackageCount(sequence, "唛头序号")).padStart(3, "0")}`;
}

export function parseInboundMarkSequence(orderNumber: string, code: string) {
  const prefix = `${orderNumber}-IN-`;
  const normalized = code.trim().toUpperCase();
  if (!normalized.startsWith(prefix.toUpperCase())) return null;
  const sequence = Number(normalized.slice(prefix.length));
  return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= MAX_INBOUND_PACKAGES
    ? sequence
    : null;
}

export function randomPzSuffix(random = Math.random) {
  return Array.from({ length: 3 }, () => PZ_ALPHABET[Math.floor(random() * PZ_ALPHABET.length)]).join("");
}

export function pzNumber(input: { warehouseSerialCode: string; at: Date; suffix: string }) {
  if (!/^\d{2}$/.test(input.warehouseSerialCode)) throw new Error("仓库两位编号未配置");
  if (!/^[2-9A-HJ-NP-Z]{3}$/.test(input.suffix)) throw new Error("配载单随机码无效");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "2-digit", month: "2-digit", day: "2-digit",
  }).formatToParts(input.at).map((part) => [part.type, part.value]));
  const yy = parts.year;
  const mm = parts.month;
  const dd = parts.day;
  return `PZ-${input.warehouseSerialCode}-${yy}${mm}${dd}-${input.suffix}`;
}
