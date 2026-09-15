import {
  MAX_CARGO_IMAGES_PER_ITEM,
  MAX_CARGO_IMAGE_STORED_BYTES,
  cargoImageSourceTypes,
} from "./cargo-images";
import {
  cargoEditorFieldPolicy,
  nextOrderPackageCodeSequence,
  resolveCargoEditorSubmission,
  type CargoEditorRecord,
  type CargoEditorWorkflowField,
} from "./order-cargo-editor";
import { valueOf } from "./validation";

type ExistingCargoRow = {
  id: string;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  overseas_hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  net_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  declared_value: number;
  currency: string;
  origin_country: string | null;
  brand_model: string | null;
  marks: string | null;
  special_attributes: string | null;
  notes: string | null;
};

type CargoPackageRow = { id: string; package_sequence: number; status: string };

export async function saveOrderCargoItem(input: {
  db: D1Database;
  organizationId: string;
  orderId: string;
  orderNumber: string;
  actorUserId: string;
  mode: "create" | "update";
  form: FormData;
  workflowFields: readonly CargoEditorWorkflowField[];
  now?: string;
}) {
  const cargoItemId = valueOf(input.form, "cargoItemId");
  if (input.mode === "update" && !cargoItemId)
    return { ok: false as const, error: "请选择要修改的货物明细" };
  if (input.mode === "create" && cargoItemId)
    return { ok: false as const, error: "新增货物不能携带旧明细标识" };
  const existing = cargoItemId
    ? await input.db.prepare(
        `SELECT id,cargo_name_cn,cargo_name_en,hs_code,overseas_hs_code,package_type,
                package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,
                length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,
                origin_country,brand_model,marks,special_attributes,notes
         FROM order_cargo_items WHERE id=? AND order_id=? AND organization_id=?`,
      ).bind(cargoItemId, input.orderId, input.organizationId).first<ExistingCargoRow>()
    : null;
  if (cargoItemId && !existing) return { ok: false as const, error: "货物明细不存在或不属于当前订单" };

  const existingImageCount = existing
    ? (await input.db.prepare(
        "SELECT COUNT(*) total FROM order_cargo_images WHERE cargo_item_id=? AND order_id=? AND organization_id=?",
      ).bind(existing.id, input.orderId, input.organizationId).first<{ total: number }>())?.total ?? 0
    : 0;
  const imagePolicy = cargoEditorFieldPolicy(input.workflowFields, "cargo_images");
  const imageFiles = imagePolicy.visible
    ? input.form.getAll("images").filter((entry): entry is File => entry instanceof File && entry.size > 0)
    : [];
  if (existingImageCount + imageFiles.length > MAX_CARGO_IMAGES_PER_ITEM)
    return { ok: false as const, error: `每条货物最多保留 ${MAX_CARGO_IMAGES_PER_ITEM} 张图片` };
  if (imageFiles.some((file) => !cargoImageSourceTypes.has(file.type) || file.size > MAX_CARGO_IMAGE_STORED_BYTES))
    return { ok: false as const, error: "仅支持 JPG、PNG 或 WebP 图片，单张不超过 600 KB" };

  const submitted: Record<string, string | string[]> = {};
  for (const [name, entry] of input.form.entries()) {
    if (entry instanceof File) continue;
    const previous = submitted[name];
    submitted[name] = previous === undefined
      ? entry
      : Array.isArray(previous) ? [...previous, entry] : [previous, entry];
  }
  const result = resolveCargoEditorSubmission({
    fields: input.workflowFields,
    submitted,
    existing: existing ? existingCargoRecord(existing) : null,
    existingImageCount,
    uploadedImageCount: imageFiles.length,
  });
  if (!result.ok) return result;

  const now = input.now ?? new Date().toISOString();
  const itemId = existing?.id ?? crypto.randomUUID();
  const packages = existing
    ? (await input.db.prepare(
        "SELECT id,package_sequence,status FROM order_cargo_packages WHERE cargo_item_id=? AND order_id=? AND organization_id=? ORDER BY package_sequence",
      ).bind(itemId, input.orderId, input.organizationId).all<CargoPackageRow>()).results
    : [];
  const activePackages = packages.filter((item) => item.status !== "cancelled");
  if (activePackages.some((item) => item.status !== "planned") && result.value.packageCount !== activePackages.length)
    return { ok: false as const, error: "货物已入库或进入后续作业，不能再修改包装数量" };

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(input.db.prepare(
      `UPDATE order_cargo_items SET cargo_name_cn=?,cargo_name_en=?,hs_code=?,overseas_hs_code=?,
        package_type=?,package_count=?,pieces_per_package=?,gross_weight_per_package_kg=?,net_weight_per_package_kg=?,
        length_cm=?,width_cm=?,height_cm=?,volume_per_package_cbm=?,declared_value=?,currency=?,origin_country=?,
        brand_model=?,marks=?,special_attributes=?,notes=?,updated_at=?
       WHERE id=? AND order_id=? AND organization_id=?`,
    ).bind(...cargoBindValues(result.value), now, itemId, input.orderId, input.organizationId));
  } else {
    const line = await input.db.prepare(
      "SELECT COALESCE(MAX(line_no),0)+1 line_no FROM order_cargo_items WHERE order_id=? AND organization_id=?",
    ).bind(input.orderId, input.organizationId).first<{ line_no: number }>();
    statements.push(input.db.prepare(
      `INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,cargo_name_en,hs_code,
        overseas_hs_code,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,
        net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,
        origin_country,brand_model,marks,special_attributes,notes,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(itemId, input.organizationId, input.orderId, line?.line_no ?? 1, ...cargoBindValues(result.value), now, now));
  }

  if (result.value.packageCount < activePackages.length) {
    for (const item of activePackages.slice(result.value.packageCount)) {
      statements.push(input.db.prepare(
        "UPDATE order_cargo_packages SET status='cancelled' WHERE id=? AND cargo_item_id=? AND organization_id=? AND status='planned'",
      ).bind(item.id, itemId, input.organizationId));
    }
  } else if (result.value.packageCount > activePackages.length) {
    const sequenceStart = packages.reduce((max, item) => Math.max(max, item.package_sequence), 0) + 1;
    const existingCodes = (await input.db.prepare(
      "SELECT package_code FROM order_cargo_packages WHERE order_id=? AND organization_id=?",
    ).bind(input.orderId, input.organizationId).all<{ package_code: string }>()).results;
    const globalSequence = nextOrderPackageCodeSequence(
      input.orderNumber,
      existingCodes.map((item) => item.package_code),
    );
    for (let index = 0; index < result.value.packageCount - activePackages.length; index++) {
      const packageNumber = globalSequence + index;
      statements.push(input.db.prepare(
        "INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(), input.organizationId, input.orderId, itemId,
        `${input.orderNumber}-P${String(packageNumber).padStart(3, "0")}`,
        sequenceStart + index, now,
      ));
    }
  }

  for (let index = 0; index < imageFiles.length; index++) {
    const file = imageFiles[index];
    const dataUrl = `data:${file.type};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
    statements.push(input.db.prepare(
      `INSERT INTO order_cargo_images(id,organization_id,order_id,cargo_item_id,file_name,content_type,
       size_bytes,data_url,sort_order,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(), input.organizationId, input.orderId, itemId, file.name, file.type,
      file.size, dataUrl, existingImageCount + index, input.actorUserId, now,
    ));
  }

  statements.push(input.db.prepare(
    `UPDATE transport_orders SET
      cargo_description=COALESCE((SELECT GROUP_CONCAT(cargo_name_cn,'、') FROM order_cargo_items WHERE order_id=? AND organization_id=?),'未填写'),
      pieces=COALESCE((SELECT SUM(package_count*pieces_per_package) FROM order_cargo_items WHERE order_id=? AND organization_id=?),1),
      gross_weight_kg=COALESCE((SELECT SUM(package_count*gross_weight_per_package_kg) FROM order_cargo_items WHERE order_id=? AND organization_id=?),0),
      volume_cbm=COALESCE((SELECT SUM(package_count*volume_per_package_cbm) FROM order_cargo_items WHERE order_id=? AND organization_id=?),0),
      updated_at=? WHERE id=? AND organization_id=?`,
  ).bind(
    input.orderId, input.organizationId, input.orderId, input.organizationId,
    input.orderId, input.organizationId, input.orderId, input.organizationId,
    now, input.orderId, input.organizationId,
  ));
  await input.db.batch(statements);
  return { ok: true as const, itemId, created: !existing, packageCount: result.value.packageCount };
}

function existingCargoRecord(row: ExistingCargoRow): CargoEditorRecord {
  return {
    cargoName: row.cargo_name_cn,
    cargoNameEn: row.cargo_name_en ?? "",
    hsCode: row.hs_code ?? "",
    overseasHsCode: row.overseas_hs_code ?? "",
    packageType: row.package_type,
    packageCount: row.package_count,
    piecesPerPackage: row.pieces_per_package,
    weight: row.gross_weight_per_package_kg,
    netWeight: row.net_weight_per_package_kg,
    length: row.length_cm,
    width: row.width_cm,
    height: row.height_cm,
    volume: row.volume_per_package_cbm,
    declaredValue: row.declared_value,
    currency: row.currency,
    originCountry: row.origin_country ?? "",
    brandModel: row.brand_model ?? "",
    marks: row.marks ?? "",
    specialAttributes: row.special_attributes ?? "",
    notes: row.notes ?? "",
  };
}

function cargoBindValues(value: CargoEditorRecord) {
  return [
    value.cargoName, value.cargoNameEn || null, value.hsCode || null, value.overseasHsCode || null,
    value.packageType, value.packageCount, value.piecesPerPackage, value.weight, value.netWeight,
    value.length, value.width, value.height, value.volume, value.declaredValue, value.currency || "USD",
    value.originCountry || null, value.brandModel || null, value.marks || null,
    value.specialAttributes || null, value.notes || null,
  ];
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
