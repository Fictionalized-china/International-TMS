import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/admin.order-operations";
import { ensureOrderModules } from "../lib/order-modules.server";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

type Order = {
  id: string;
  order_number: string;
  customer_name: string;
  origin_city: string;
  destination_city: string;
  status: string;
};
type Cargo = {
  id: string;
  line_no: number;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  volume_per_package_cbm: number;
  marks: string | null;
};
type Package = {
  id: string;
  package_code: string;
  cargo_name_cn: string;
  package_type: string;
  gross_weight_per_package_kg: number;
  volume_per_package_cbm: number;
  status: string;
};
type Batch = {
  id: string;
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  planned_departure_at: string | null;
  status: string;
};
type Vehicle = {
  id: string;
  batch_id: string;
  vehicle_no: string;
  plate_number: string | null;
  carrier_name: string | null;
  driver_name: string | null;
  capacity_weight_kg: number;
  capacity_volume_cbm: number;
  loaded_packages: number;
  loaded_weight: number;
  loaded_volume: number;
};
type Load = {
  id: string;
  batch_id: string;
  vehicle_id: string;
  package_id: string;
  vehicle_no: string;
  package_code: string;
  cargo_name_cn: string;
};
type Booking = {
  id: string;
  booking_number: string;
  booking_type: string;
  carrier_name: string | null;
  booking_agent: string | null;
  carrier_reference: string | null;
  equipment_type: string | null;
  equipment_quantity: number;
  planned_departure_at: string | null;
  status: string;
};
type Expense = {
  id: string;
  direction: string;
  stage: string;
  charge_code: string;
  charge_name: string;
  counterparty_name: string | null;
  currency: string;
  quantity: number;
  unit_price: number;
  amount: number;
  base_amount: number;
};
type Service = {
  id: string;
  service_code: string;
  service_name: string;
  status: string;
};
type CargoImage = {
  id: string;
  cargo_item_id: string;
  file_name: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view"),
    orderId = params.orderId,
    returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"), orderId);
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,c.name customer_name,o.origin_city,o.destination_city,o.status FROM transport_orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, current.organizationId)
    .first<Order>();
  if (!order) throw new Response("订单不存在", { status: 404 });
  const [cargo, packages, batches, vehicles] = await Promise.all([
    env.DB.prepare(
      "SELECT id,line_no,cargo_name_cn,cargo_name_en,hs_code,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,volume_per_package_cbm,marks FROM order_cargo_items WHERE order_id=? ORDER BY line_no",
    )
      .bind(orderId)
      .all<Cargo>(),
    env.DB.prepare(
      `SELECT p.id,p.package_code,i.cargo_name_cn,i.package_type,i.gross_weight_per_package_kg,i.volume_per_package_cbm,p.status FROM order_cargo_packages p JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE p.order_id=? ORDER BY p.package_code`,
    )
      .bind(orderId)
      .all<Package>(),
    env.DB.prepare(
      "SELECT id,batch_number,batch_name,origin_location,destination_location,planned_departure_at,status FROM transport_batches b WHERE b.order_id=? OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.order_id=? AND bo.status!='removed') ORDER BY b.created_at",
    )
      .bind(orderId, orderId)
      .all<Batch>(),
    env.DB.prepare(
      `SELECT v.id,v.batch_id,v.vehicle_no,v.plate_number,c.name carrier_name,v.driver_name,v.capacity_weight_kg,v.capacity_volume_cbm,COUNT(l.id) loaded_packages,COALESCE(SUM(i.gross_weight_per_package_kg),0) loaded_weight,COALESCE(SUM(i.volume_per_package_cbm),0) loaded_volume FROM transport_batch_vehicles v LEFT JOIN carriers c ON c.id=v.carrier_id LEFT JOIN transport_vehicle_loads l ON l.vehicle_id=v.id LEFT JOIN order_cargo_packages p ON p.id=l.package_id LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE v.batch_id IN(SELECT b.id FROM transport_batches b WHERE b.order_id=? OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.order_id=? AND bo.status!='removed')) GROUP BY v.id ORDER BY v.created_at`,
    )
      .bind(orderId, orderId)
      .all<Vehicle>(),
  ]);
  const [loads, bookings, expenses, services] = await Promise.all([
    env.DB.prepare(
      `SELECT l.id,l.batch_id,l.vehicle_id,l.package_id,v.vehicle_no,p.package_code,i.cargo_name_cn FROM transport_vehicle_loads l JOIN transport_batch_vehicles v ON v.id=l.vehicle_id JOIN order_cargo_packages p ON p.id=l.package_id JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE p.order_id=? ORDER BY l.created_at`,
    )
      .bind(orderId)
      .all<Load>(),
    env.DB.prepare(
      `SELECT b.id,b.booking_number,b.booking_type,c.name carrier_name,b.booking_agent,b.carrier_reference,b.equipment_type,b.equipment_quantity,b.planned_departure_at,b.status FROM booking_records b LEFT JOIN carriers c ON c.id=b.carrier_id WHERE b.order_id=? ORDER BY b.created_at`,
    )
      .bind(orderId)
      .all<Booking>(),
    env.DB.prepare(
      "SELECT id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,base_amount FROM business_expenses WHERE order_id=? ORDER BY created_at",
    )
      .bind(orderId)
      .all<Expense>(),
    env.DB.prepare(
      "SELECT id,service_code,service_name,status FROM order_services WHERE order_id=? ORDER BY created_at",
    )
      .bind(orderId)
      .all<Service>(),
  ]);
  const [carriers, cargoImages] = await Promise.all([
    env.DB.prepare(
      "SELECT id,name FROM carriers WHERE organization_id=? AND status='active' ORDER BY name",
    )
      .bind(current.organizationId)
      .all<{ id: string; name: string }>(),
    env.DB.prepare(
      "SELECT id,cargo_item_id,file_name FROM order_cargo_images WHERE order_id=? AND organization_id=? ORDER BY sort_order,created_at",
    )
      .bind(orderId, current.organizationId)
      .all<CargoImage>(),
  ]);
  const receivable = expenses.results
      .filter((x) => x.direction === "receivable")
      .reduce((n, x) => n + x.base_amount, 0),
    payable = expenses.results
      .filter((x) => x.direction === "payable")
      .reduce((n, x) => n + x.base_amount, 0);
  return {
    current,
    order,
    cargo: cargo.results,
    packages: packages.results,
    batches: batches.results,
    vehicles: vehicles.results,
    loads: loads.results,
    bookings: bookings.results,
    expenses: expenses.results,
    services: services.results,
    carriers: carriers.results,
    cargoImages: cargoImages.results,
    returnTo,
    summary: { receivable, payable, margin: receivable - payable },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.manage"),
    orderId = params.orderId,
    form = await request.formData(),
    intent = valueOf(form, "intent"),
    now = new Date().toISOString();
  if (intent)
    return {
      formError:
        "旧订单操作页已进入只读兼容模式，请返回订单详情并进入对应业务模块办理。",
    };
  const order = await env.DB.prepare(
    "SELECT id,order_number,origin_city,destination_city FROM transport_orders WHERE id=? AND organization_id=?",
  )
    .bind(orderId, current.organizationId)
    .first<{
      id: string;
      order_number: string;
      origin_city: string;
      destination_city: string;
    }>();
  if (!order) return { formError: "订单不存在" };
  if (["batch", "vehicle", "load"].includes(intent)) {
    throw redirect("/admin/loading");
  }
  if (intent === "service") {
    const code = valueOf(form, "serviceCode"),
      name = serviceNames[code];
    if (!name) return { formError: "服务类型无效" };
    try {
      await env.DB.prepare(
        "INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          current.organizationId,
          orderId,
          code,
          name,
          now,
        )
        .run();
    } catch {
      return { formError: "该委托服务已经存在" };
    }
    await ensureOrderModules(current.organizationId, orderId);
    return audit(
      request,
      current,
      "order.service.create",
      orderId,
      { code },
      `${name}服务已添加`,
    );
  }
  if (intent === "cargo") {
    const name = valueOf(form, "cargoName"),
      packageType = valueOf(form, "packageType"),
      count = positiveInt(form, "packageCount"),
      pieces = positiveInt(form, "piecesPerPackage"),
      weight = nonNegative(form, "weight"),
      netWeight = nonNegative(form, "netWeight"),
      length = nonNegative(form, "length"),
      width = nonNegative(form, "width"),
      height = nonNegative(form, "height"),
      volume =
        nonNegative(form, "volume") || (length * width * height) / 1_000_000;
    if (!name || !packageType || !count || !pieces || count > 500)
      return { formError: "请填写货品、包装类型和1–500个包装" };
    const row = await env.DB.prepare(
        "SELECT COALESCE(MAX(line_no),0)+1 line_no FROM order_cargo_items WHERE order_id=?",
      )
        .bind(orderId)
        .first<{ line_no: number }>(),
      existing = await env.DB.prepare(
        "SELECT COUNT(*) total FROM order_cargo_packages WHERE order_id=?",
      )
        .bind(orderId)
        .first<{ total: number }>(),
      itemId = crypto.randomUUID(),
      start = (existing?.total ?? 0) + 1;
    const statements = [
      env.DB.prepare(
        `INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,cargo_name_en,hs_code,overseas_hs_code,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,origin_country,brand_model,marks,special_attributes,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        itemId,
        current.organizationId,
        orderId,
        row?.line_no ?? 1,
        name,
        valueOf(form, "cargoNameEn") || null,
        valueOf(form, "hsCode") || null,
        valueOf(form, "overseasHsCode") || null,
        packageType,
        count,
        pieces,
        weight,
        netWeight,
        length,
        width,
        height,
        volume,
        nonNegative(form, "declaredValue"),
        valueOf(form, "currency") || "USD",
        valueOf(form, "originCountry") || null,
        valueOf(form, "brandModel") || null,
        valueOf(form, "marks") || null,
        form.getAll("specialAttributes").map(String).join(",") || null,
        valueOf(form, "notes") || null,
        now,
        now,
      ),
    ];
    for (let i = 0; i < count; i++) {
      const seq = start + i;
      statements.push(
        env.DB.prepare(
          "INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at) VALUES(?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          orderId,
          itemId,
          `${order.order_number}-P${String(seq).padStart(3, "0")}`,
          i + 1,
          now,
        ),
      );
    }
    const imageFiles = form
      .getAll("images")
      .filter(
        (entry): entry is File => entry instanceof File && entry.size > 0,
      );
    if (
      imageFiles.length > 5 ||
      imageFiles.some(
        (file) =>
          !file.type.startsWith("image/") || file.size > 2 * 1024 * 1024,
      )
    )
      return { formError: "每条货物最多5张图片，单张不超过2 MB" };
    for (let imageIndex = 0; imageIndex < imageFiles.length; imageIndex++) {
      const file = imageFiles[imageIndex];
      statements.push(
        env.DB.prepare(
          "INSERT INTO order_cargo_images(id,organization_id,order_id,cargo_item_id,file_name,content_type,size_bytes,data_url,sort_order,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          orderId,
          itemId,
          file.name,
          file.type,
          file.size,
          await fileToDataUrl(file),
          imageIndex,
          current.userId,
          now,
        ),
      );
    }
    await env.DB.batch(statements);
    await refreshOrderCargo(orderId, current.organizationId, now);
    return audit(
      request,
      current,
      "order.cargo.create",
      itemId,
      { count },
      `已添加 ${count} 个包装并生成包装编号`,
    );
  }
  if (intent === "batch") {
    return { formError: "配载单统一由仓库端“货物配载”创建，管理后台仅负责跟踪已生成配载单" };
  }
  if (intent === "vehicle") {
    const batchId = valueOf(form, "batchId");
    if (!(await ownedBatch(batchId, orderId, current.organizationId)))
      return { formError: "运输批次无效" };
    const vehicleNo = valueOf(form, "vehicleNo"),
      plate = valueOf(form, "plateNumber");
    if (!vehicleNo) return { formError: "请填写车辆序号" };
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,plate_number,carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          id,
          current.organizationId,
          batchId,
          vehicleNo,
          plate || null,
          valueOf(form, "carrierId") || null,
          valueOf(form, "driverName") || null,
          valueOf(form, "driverPhone") || null,
          nonNegative(form, "capacityWeight"),
          nonNegative(form, "capacityVolume"),
          now,
          now,
        )
        .run();
    } catch {
      return { formError: "同一批次的车辆序号不能重复" };
    }
    return audit(
      request,
      current,
      "transport.vehicle.create",
      id,
      { batchId, vehicleNo },
      "车辆已加入运输批次",
    );
  }
  if (intent === "load") {
    const batchId = valueOf(form, "batchId"),
      vehicleId = valueOf(form, "vehicleId"),
      packageId = valueOf(form, "packageId");
    const vehicle = await env.DB.prepare(
      `SELECT v.id,v.capacity_weight_kg,v.capacity_volume_cbm FROM transport_batch_vehicles v JOIN transport_batches b ON b.id=v.batch_id WHERE v.id=? AND v.batch_id=? AND b.organization_id=? AND (b.order_id=? OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.order_id=? AND bo.status!='removed'))`,
    )
      .bind(vehicleId, batchId, current.organizationId, orderId, orderId)
      .first<{
        id: string;
        capacity_weight_kg: number;
        capacity_volume_cbm: number;
      }>();
    const pkg = await env.DB.prepare(
      `SELECT p.id,i.gross_weight_per_package_kg weight,i.volume_per_package_cbm volume FROM order_cargo_packages p JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE p.id=? AND p.order_id=? AND p.status!='cancelled'`,
    )
      .bind(packageId, orderId)
      .first<{ id: string; weight: number; volume: number }>();
    if (!vehicle || !pkg) return { formError: "车辆或包装无效" };
    const used = await env.DB.prepare(
      `SELECT COALESCE(SUM(i.gross_weight_per_package_kg),0) weight,COALESCE(SUM(i.volume_per_package_cbm),0) volume FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE l.vehicle_id=?`,
    )
      .bind(vehicleId)
      .first<{ weight: number; volume: number }>();
    if (
      vehicle.capacity_weight_kg > 0 &&
      (used?.weight ?? 0) + pkg.weight > vehicle.capacity_weight_kg
    )
      return { formError: "该车辆装载后将超过重量容量" };
    if (
      vehicle.capacity_volume_cbm > 0 &&
      (used?.volume ?? 0) + pkg.volume > vehicle.capacity_volume_cbm
    )
      return { formError: "该车辆装载后将超过体积容量" };
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO transport_vehicle_loads(id,organization_id,batch_id,vehicle_id,package_id,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          batchId,
          vehicleId,
          packageId,
          current.userId,
          now,
        ),
        env.DB.prepare(
          "UPDATE order_cargo_packages SET status='loaded' WHERE id=?",
        ).bind(packageId),
      ]);
    } catch {
      return { formError: "该包装已经分配到本批次的其他车辆" };
    }
    return audit(
      request,
      current,
      "transport.load.assign",
      packageId,
      { batchId, vehicleId },
      "包装已分配到车辆",
    );
  }
  if (intent === "booking") {
    const count = await env.DB.prepare(
        "SELECT COUNT(*) total FROM booking_records WHERE order_id=?",
      )
        .bind(orderId)
        .first<{ total: number }>(),
      seq = (count?.total ?? 0) + 1,
      id = crypto.randomUUID(),
      number = `BK-${order.order_number}-${String(seq).padStart(2, "0")}`;
    await env.DB.prepare(
      `INSERT INTO booking_records(id,organization_id,order_id,booking_number,booking_type,carrier_id,booking_agent,carrier_reference,equipment_type,equipment_quantity,service_reference,planned_departure_at,planned_arrival_at,cutoff_at,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        current.organizationId,
        orderId,
        number,
        valueOf(form, "bookingType") || "road",
        valueOf(form, "carrierId") || null,
        valueOf(form, "bookingAgent") || null,
        valueOf(form, "carrierReference") || null,
        valueOf(form, "equipmentType") || null,
        positiveInt(form, "equipmentQuantity") || 1,
        valueOf(form, "serviceReference") || null,
        valueOf(form, "departure") || null,
        valueOf(form, "arrival") || null,
        valueOf(form, "cutoff") || null,
        valueOf(form, "status") || "draft",
        valueOf(form, "notes") || null,
        current.userId,
        now,
        now,
      )
      .run();
    return audit(
      request,
      current,
      "booking.create",
      id,
      { number },
      `订舱记录 ${number} 已创建`,
    );
  }
  if (intent === "expense") {
    const direction = valueOf(form, "direction"),
      name = valueOf(form, "chargeName"),
      quantity = positiveNumber(form, "quantity") || 1,
      unitPrice = nonNegative(form, "unitPrice"),
      rate = positiveNumber(form, "exchangeRate") || 1,
      amount = quantity * unitPrice,
      id = crypto.randomUUID();
    if (!["receivable", "payable"].includes(direction) || !name)
      return { formError: "费用方向或费用名称无效" };
    await env.DB.prepare(
      `INSERT INTO business_expenses(id,organization_id,order_id,booking_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'estimated',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        current.organizationId,
        orderId,
        valueOf(form, "bookingId") || null,
        direction,
        valueOf(form, "chargeCode") || "OTHER",
        name,
        valueOf(form, "counterparty") || null,
        valueOf(form, "currency") || "USD",
        quantity,
        unitPrice,
        amount,
        rate,
        amount * rate,
        valueOf(form, "notes") || null,
        current.userId,
        now,
        now,
      )
      .run();
    return audit(
      request,
      current,
      "expense.estimate.create",
      id,
      { direction, amount },
      "预估费用已添加",
    );
  }
  return { formError: "未知操作" };
}

async function audit(
  request: Request,
  current: { organizationId: string; userId: string },
  action: string,
  id: string,
  metadata: Record<string, unknown>,
  success: string,
) {
  await writeAudit({
    request,
    action,
    resourceType: "transport_order_operation",
    resourceId: id,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata,
  });
  return { success };
}
function safeReturnTo(value: string | null, orderId: string) {
  const fallback = `/admin/orders/${orderId}`;
  if (!value) return fallback;
  if (
    value === fallback ||
    value.startsWith(`${fallback}?`) ||
    value.startsWith(`${fallback}/modules/`)
  )
    return value;
  return fallback;
}
async function ownedBatch(id: string, orderId: string, org: string) {
  return env.DB.prepare(
    "SELECT 1 FROM transport_batches b WHERE b.id=? AND b.organization_id=? AND (b.order_id=? OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.order_id=? AND bo.status!='removed'))",
  )
    .bind(id, org, orderId, orderId)
    .first();
}
async function refreshOrderCargo(orderId: string, org: string, now: string) {
  await env.DB.prepare(
    `UPDATE transport_orders SET cargo_description=COALESCE((SELECT GROUP_CONCAT(cargo_name_cn,'、') FROM order_cargo_items WHERE order_id=?),'未填写'),pieces=COALESCE((SELECT SUM(package_count*pieces_per_package) FROM order_cargo_items WHERE order_id=?),1),gross_weight_kg=COALESCE((SELECT SUM(package_count*gross_weight_per_package_kg) FROM order_cargo_items WHERE order_id=?),0),volume_cbm=COALESCE((SELECT SUM(package_count*volume_per_package_cbm) FROM order_cargo_items WHERE order_id=?),0),updated_at=? WHERE id=? AND organization_id=?`,
  )
    .bind(orderId, orderId, orderId, orderId, now, orderId, org)
    .run();
}
async function fileToDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${file.type};base64,${btoa(binary)}`;
}
function nonNegative(form: FormData, name: string) {
  const n = Number(valueOf(form, name) || 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function positiveNumber(form: FormData, name: string) {
  const n = Number(valueOf(form, name) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function positiveInt(form: FormData, name: string) {
  return Math.floor(positiveNumber(form, name));
}
const serviceNames: Record<string, string> = {
  booking: "订舱",
  container: "用箱",
  pickup: "提货",
  warehouse: "仓储",
  packing: "包装",
  customs: "报关",
  insurance: "保险",
  destination_customs: "目的地清关",
  destination_warehouse: "目的地仓储",
  other: "其他服务",
};

export default function OrderOperations({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const d = loaderData,
    busy = useNavigation().state !== "idle",
    available = (batchId: string) =>
      d.packages.filter(
        (p) =>
          !d.loads.some((l) => l.batch_id === batchId && l.package_id === p.id),
      );
  return (
    <div className="legacy-readonly-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">LEGACY ORDER OPERATIONS</p>
          <h1>{d.order.order_number} · 历史业务执行（只读）</h1>
          <p>
            {d.order.customer_name} · {d.order.origin_city} →{" "}
            {d.order.destination_city}
          </p>
        </div>
        <Link className="secondary" to={d.returnTo}>
          返回来源位置
        </Link>
      </header>
      <div className="alert legacy-readonly-notice">
        <span>此页面仅用于核对历史数据，新增和修改请从订单详情进入对应业务模块。</span>
        <Link className="secondary" to={d.returnTo}>
          返回订单挂载页
        </Link>
      </div>
      {actionData && (
        <div
          className={`alert ${"formError" in actionData ? "error" : "success"}`}
        >
          {"formError" in actionData
            ? actionData.formError
            : actionData.success}
        </div>
      )}
      <nav className="operation-jump">
        <a href="#cargo">货品包装</a>
        <a href="#loading">批次配载</a>
        <a href="#booking">订舱</a>
        <a href="#expense">预估费用</a>
      </nav>
      <section className="panel" id="services">
        <div className="panel-header">
          <div>
            <h2>委托服务</h2>
            <p>服务选择决定后续业务节点。</p>
          </div>
        </div>
        <div className="chip-list">
          {d.services.map((s) => (
            <span className="status-pill" key={s.id}>
              {s.service_name}
            </span>
          ))}
        </div>
        <Form method="post" className="inline-form">
          <input type="hidden" name="intent" value="service" />
          <select name="serviceCode">
            {Object.entries(serviceNames).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
          <button className="secondary" disabled={busy}>
            添加服务
          </button>
        </Form>
      </section>
      <section className="panel" id="cargo">
        <div className="panel-header">
          <div>
            <h2>货品与最小包装单位</h2>
            <p>相同包装可按数量录入，系统为每箱/托盘生成独立编号。</p>
          </div>
          <div className="page-actions">
            <span className="status-pill">{d.packages.length} 个包装</span>
            <Link
              className="secondary"
              to={`/admin/orders/${d.order.id}/packages/print`}
            >
              打印包装标签
            </Link>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>品名/HS Code</th>
                <th>包装</th>
                <th>每包装件数</th>
                <th>单包装重量</th>
                <th>单包装体积</th>
                <th>唛头</th>
                <th>图片</th>
              </tr>
            </thead>
            <tbody>
              {d.cargo.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.cargo_name_cn}</strong>
                    <small>
                      {x.cargo_name_en || "—"} · {x.hs_code || "无 HS Code"}
                    </small>
                  </td>
                  <td>
                    {x.package_type} × {x.package_count}
                  </td>
                  <td>{x.pieces_per_package}</td>
                  <td>{x.gross_weight_per_package_kg} KG</td>
                  <td>{x.volume_per_package_cbm.toFixed(4)} CBM</td>
                  <td>{x.marks || "—"}</td>
                  <td>
                    <div className="cargo-table-images">
                      {d.cargoImages
                        .filter((image) => image.cargo_item_id === x.id)
                        .slice(0, 4)
                        .map((image) => (
                          <a
                            href={`/admin/cargo-images/${image.id}`}
                            target="_blank"
                            rel="noreferrer"
                            key={image.id}
                          >
                            <img src={`/admin/cargo-images/${image.id}`} alt={image.file_name} loading="lazy" />
                          </a>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="expandable">
          <summary>新增货品包装</summary>
          <Form
            method="post"
            encType="multipart/form-data"
            className="form-grid"
          >
            <input type="hidden" name="intent" value="cargo" />
            <Field name="cargoName" label="中文品名" required />
            <Field name="cargoNameEn" label="英文品名" />
            <Field name="hsCode" label="HS Code" />
            <Field name="overseasHsCode" label="国外 HS Code" />
            <Select
              name="packageType"
              label="包装类型"
              items={[
                ["carton", "纸箱"],
                ["pallet", "托盘"],
                ["wooden_case", "木箱"],
                ["wooden_frame", "木架"],
                ["bag", "袋"],
                ["bare", "裸件"],
                ["other", "其他"],
              ]}
            />
            <NumberField name="packageCount" label="包装数量" value="1" />
            <NumberField name="piecesPerPackage" label="每包装件数" value="1" />
            <NumberField name="weight" label="单包装毛重 KG" step="0.001" />
            <NumberField name="netWeight" label="单包装净重 KG" step="0.001" />
            <NumberField name="length" label="长 cm" step="0.1" />
            <NumberField name="width" label="宽 cm" step="0.1" />
            <NumberField name="height" label="高 cm" step="0.1" />
            <NumberField
              name="volume"
              label="单包装体积 CBM（留空自动算）"
              step="0.0001"
            />
            <Field name="marks" label="唛头" />
            <Field name="brandModel" label="品牌/型号" />
            <Field name="originCountry" label="原产国" />
            <NumberField name="declaredValue" label="申报货值" step="0.01" />
            <Field name="currency" label="币种" value="USD" />
            <div className="field span-2">
              <span>特殊属性</span>
              <div className="check-row">
                {[
                  ["dangerous", "危险品"],
                  ["battery", "带电"],
                  ["liquid", "液体"],
                  ["magnetic", "磁性"],
                ].map(([v, t]) => (
                  <label key={v}>
                    <input type="checkbox" name="specialAttributes" value={v} />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
            </div>
            <Field name="notes" label="货物备注" wide />
            <label className="field span-2">
              <span>货物图片</span>
              <input
                name="images"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
              />
              <small>最多5张，单张不超过2 MB</small>
            </label>
            <button className="primary" disabled={busy}>
              保存并生成包装编号
            </button>
          </Form>
        </details>
      </section>
      <section className="panel" id="loading">
        <div className="panel-header">
          <div>
            <h2>拼车配载</h2>
            <p>
              拼车配载已统一迁移到跨订单工作台。系统以完整订单为最小配载单位，
              可筛选同线路的多票订单并一键生成配载批次。
            </p>
          </div>
          <Link className="primary" to="/admin/loading">
            进入拼车配载工作台
          </Link>
        </div>
      </section>
      <section className="panel" id="legacy-loading" hidden>
        <div className="panel-header">
          <div>
            <h2>运输批次与分车配载</h2>
            <p>同一批货可拆分至不同车辆；每个包装在同一批次只能分配一次。</p>
          </div>
        </div>
        <div className="batch-grid">
          {d.batches.map((b) => (
            <article className="batch-card" key={b.id}>
              <header>
                <div>
                  <strong>
                    {b.batch_number} · {b.batch_name}
                  </strong>
                  <small>
                    {b.origin_location} → {b.destination_location}
                  </small>
                </div>
                <span className="status-pill">{b.status}</span>
              </header>
              {d.vehicles
                .filter((v) => v.batch_id === b.id)
                .map((v) => (
                  <div className="vehicle-row" key={v.id}>
                    <div>
                      <strong>
                        {v.vehicle_no} · {v.plate_number || "车牌待定"}
                      </strong>
                      <small>
                        {v.carrier_name || "承运商待定"} ·{" "}
                        {v.driver_name || "司机待定"}
                      </small>
                    </div>
                    <div>
                      <b>{v.loaded_packages} 包装</b>
                      <small>
                        {v.loaded_weight.toFixed(2)}/
                        {v.capacity_weight_kg || "∞"} KG ·{" "}
                        {v.loaded_volume.toFixed(3)}/
                        {v.capacity_volume_cbm || "∞"} CBM
                      </small>
                    </div>
                    <Form method="post" className="inline-form compact">
                      <input type="hidden" name="intent" value="load" />
                      <input type="hidden" name="batchId" value={b.id} />
                      <input type="hidden" name="vehicleId" value={v.id} />
                      <select name="packageId" required>
                        <option value="">选择未配载包装</option>
                        {available(b.id).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.package_code} · {p.cargo_name_cn}
                          </option>
                        ))}
                      </select>
                      <button className="text-button" disabled={busy}>
                        分配
                      </button>
                    </Form>
                  </div>
                ))}
              <details className="expandable">
                <summary>添加车辆</summary>
                <Form method="post" className="form-grid compact">
                  <input type="hidden" name="intent" value="vehicle" />
                  <input type="hidden" name="batchId" value={b.id} />
                  <Field
                    name="vehicleNo"
                    label="车辆序号"
                    value={`车${d.vehicles.filter((v) => v.batch_id === b.id).length + 1}`}
                  />
                  <Field name="plateNumber" label="车牌号" />
                  <Select
                    name="carrierId"
                    label="承运商"
                    optional
                    items={d.carriers.map((c) => [c.id, c.name])}
                  />
                  <Field name="driverName" label="司机" />
                  <Field name="driverPhone" label="司机电话" />
                  <NumberField name="capacityWeight" label="载重上限 KG" />
                  <NumberField
                    name="capacityVolume"
                    label="体积上限 CBM"
                    step="0.001"
                  />
                  <button className="secondary" disabled={busy}>
                    添加车辆
                  </button>
                </Form>
              </details>
            </article>
          ))}
        </div>
        <details className="expandable">
          <summary>新建运输批次</summary>
          <Form method="post" className="form-grid compact">
            <input type="hidden" name="intent" value="batch" />
            <Field name="batchName" label="批次名称" />
            <Field name="origin" label="起点" value={d.order.origin_city} />
            <Field
              name="destination"
              label="终点"
              value={d.order.destination_city}
            />
            <DateTime name="departure" label="计划发车" />
            <DateTime name="arrival" label="计划到达" />
            <Field name="notes" label="备注" wide />
            <button className="primary" disabled={busy}>
              创建批次
            </button>
          </Form>
        </details>
      </section>
      <section className="panel" id="booking">
        <div className="panel-header">
          <div>
            <h2>订舱记录</h2>
            <p>订舱作为业务节点产生，可分批建立多条记录。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>订舱号</th>
                <th>方式/承运人</th>
                <th>设备</th>
                <th>参考号</th>
                <th>计划发运</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {d.bookings.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.booking_number}</strong>
                  </td>
                  <td>
                    {x.booking_type}
                    <small>
                      {x.carrier_name || x.booking_agent || "待确定"}
                    </small>
                  </td>
                  <td>
                    {x.equipment_type || "—"} × {x.equipment_quantity}
                  </td>
                  <td>{x.carrier_reference || "—"}</td>
                  <td>{x.planned_departure_at?.replace("T", " ") || "—"}</td>
                  <td>
                    <span className="status-pill">{x.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="expandable">
          <summary>新增订舱记录</summary>
          <Form method="post" className="form-grid compact">
            <input type="hidden" name="intent" value="booking" />
            <Select
              name="bookingType"
              label="订舱类型"
              items={[
                ["road", "公路"],
                ["rail", "铁路"],
                ["sea", "海运"],
                ["air", "空运"],
              ]}
            />
            <Select
              name="carrierId"
              label="承运人"
              optional
              items={d.carriers.map((c) => [c.id, c.name])}
            />
            <Field name="bookingAgent" label="订舱代理" />
            <Field name="carrierReference" label="承运人订舱号" />
            <Field name="equipmentType" label="箱型/车型" />
            <NumberField name="equipmentQuantity" label="数量" value="1" />
            <Field name="serviceReference" label="车次/班列/航次/航班" />
            <DateTime name="departure" label="计划发运" />
            <DateTime name="arrival" label="计划到达" />
            <DateTime name="cutoff" label="截单/截仓时间" />
            <Select
              name="status"
              label="状态"
              items={[
                ["draft", "草稿"],
                ["submitted", "已提交"],
                ["confirmed", "已确认"],
              ]}
            />
            <Field name="notes" label="备注" wide />
            <button className="primary" disabled={busy}>
              新增订舱
            </button>
          </Form>
        </details>
      </section>
      <section className="panel" id="expense">
        <div className="panel-header">
          <div>
            <h2>独立预估费用</h2>
            <p>费用独立保存并与订单关联，包含应收与应付。</p>
          </div>
          <div className="margin-summary">
            <span>
              预计应收 <b>{d.summary.receivable.toFixed(2)}</b>
            </span>
            <span>
              预计应付 <b>{d.summary.payable.toFixed(2)}</b>
            </span>
            <span>
              预计毛利 <b>{d.summary.margin.toFixed(2)}</b>
            </span>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>方向</th>
                <th>费用</th>
                <th>往来方</th>
                <th>数量×单价</th>
                <th>金额</th>
                <th>阶段</th>
              </tr>
            </thead>
            <tbody>
              {d.expenses.map((x) => (
                <tr key={x.id}>
                  <td>
                    <span
                      className={`status-pill ${x.direction === "payable" ? "off" : ""}`}
                    >
                      {x.direction === "receivable" ? "应收" : "应付"}
                    </span>
                  </td>
                  <td>
                    {x.charge_code} · {x.charge_name}
                  </td>
                  <td>{x.counterparty_name || "—"}</td>
                  <td>
                    {x.quantity} × {x.unit_price}
                  </td>
                  <td>
                    <strong>
                      {x.currency} {x.amount.toFixed(2)}
                    </strong>
                  </td>
                  <td>{x.stage === "estimated" ? "预估" : "已确认"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="expandable">
          <summary>新增预估费用</summary>
          <Form method="post" className="form-grid compact">
            <input type="hidden" name="intent" value="expense" />
            <Select
              name="direction"
              label="收付方向"
              items={[
                ["receivable", "应收"],
                ["payable", "应付"],
              ]}
            />
            <Field name="chargeCode" label="费用代码" value="FREIGHT" />
            <Field name="chargeName" label="费用名称" value="运输费" />
            <Field name="counterparty" label="客户/供应商" />
            <Field name="currency" label="币种" value="USD" />
            <NumberField name="quantity" label="数量" value="1" step="0.01" />
            <NumberField name="unitPrice" label="单价" step="0.01" />
            <NumberField
              name="exchangeRate"
              label="本位币汇率"
              value="1"
              step="0.0001"
            />
            <Select
              name="bookingId"
              label="关联订舱"
              optional
              items={d.bookings.map((b) => [b.id, b.booking_number])}
            />
            <Field name="notes" label="备注" wide />
            <button className="primary" disabled={busy}>
              保存预估费用
            </button>
          </Form>
        </details>
      </section>
    </div>
  );
}

function Field({
  name,
  label,
  required,
  value,
  wide,
}: {
  name: string;
  label: string;
  required?: boolean;
  value?: string;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "span-2" : ""}`}>
      <span>{label}</span>
      <input name={name} required={required} defaultValue={value} />
    </label>
  );
}
function NumberField({
  name,
  label,
  value = "0",
  step = "1",
}: {
  name: string;
  label: string;
  value?: string;
  step?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type="number"
        min="0"
        step={step}
        defaultValue={value}
      />
    </label>
  );
}
function DateTime({ name, label }: { name: string; label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type="datetime-local" />
    </label>
  );
}
function Select({
  name,
  label,
  items,
  optional,
}: {
  name: string;
  label: string;
  items: [string, string][];
  optional?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} required={!optional}>
        <option value="">{optional ? "未指定" : "请选择"}</option>
        {items.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
export function meta() {
  return [{ title: "订单业务执行 | International TMS" }];
}
