export const MAX_CARGO_IMAGES_PER_ITEM = 5;
export const MAX_CARGO_IMAGE_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_CARGO_IMAGE_STORED_BYTES = 600 * 1024;

export const cargoImageSourceTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type CargoImagePayload = {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

export type CargoImageParseResult =
  | { ok: true; images: CargoImagePayload[] }
  | { ok: false; images: []; error: string };

export function parseCargoImagePayloads(raw: string): CargoImageParseResult {
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    return invalid("图片数据格式无效，请重新选择图片");
  }
  if (!Array.isArray(values)) return invalid("图片数据格式无效，请重新选择图片");
  if (values.length > MAX_CARGO_IMAGES_PER_ITEM)
    return invalid(`每条货物最多上传 ${MAX_CARGO_IMAGES_PER_ITEM} 张图片`);

  const images: CargoImagePayload[] = [];
  for (const value of values) {
    if (!isRecord(value)) return invalid("图片数据格式无效，请重新选择图片");
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const type = typeof value.type === "string" ? value.type : "";
    const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl : "";
    const bytes = dataUrlBytes(dataUrl);
    if (!name || !cargoImageSourceTypes.has(type) || bytes === null)
      return invalid("仅支持 JPG、PNG 或 WebP 图片，请重新选择");
    if (bytes <= 0 || bytes > MAX_CARGO_IMAGE_STORED_BYTES)
      return invalid("图片压缩结果仍然过大，请重新选择或降低图片尺寸");
    images.push({ name, type, size: bytes, dataUrl });
  }
  return { ok: true, images };
}

export function dataUrlBytes(dataUrl: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
    dataUrl,
  );
  if (!match) return null;
  const payload = match[2];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function invalid(error: string): CargoImageParseResult {
  return { ok: false, images: [], error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
