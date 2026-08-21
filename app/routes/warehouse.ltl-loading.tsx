import { env } from "cloudflare:workers";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.ltl-loading";
import { Modal } from "../components/Modal";
import { writeAudit } from "../lib/audit.server";
import { requireSessionUser } from "../lib/auth.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { valueOf } from "../lib/validation";

const DEFAULT_PAGE_SIZE = 30;
const PAGE_SIZES = [30, 50, 100];

type CargoRow = {
  batch_id: string | null;
  batch_number: string | null;
  batch_name: string | null;
  batch_warehouse_id: string | null;
  batch_order_count: number;
  order_id: string;
  order_number: string;
  business_type: string;
  customer_name: string;
  cargo_names: string | null;
  overseas_warehouse_name: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  border_port: string | null;
  customs_location: string | null;
  planned_departure_at: string | null;
  package_count: number;
  pieces: number;
  weight_kg: number;
  volume_cbm: number;
  location_names: string | null;
  cargo_ready: number;
  sorting_ready: number;
  has_exception: number;
  active_dispatch: number;
};

type DispatchRow = {
  id: string;
  dispatch_number: string;
  transport_batch_id: string;
  batch_number: string;
  order_numbers: string;
  cargo_names: string | null;
  customer_names: string | null;
  destination: string;
  status: string;
  item_count: number;
  loaded_count: number;
  weight_kg: number;
  volume_cbm: number;
  vehicle_plate: string;
  driver_name: string;
  carrier_name: string | null;
  planned_loading_at: string | null;
  created_at: string;
};

type ReferenceOption = {
  category: "border_port" | "customs_place";
  code: string;
  name: string;
};

type Selection = {
  orderId: string;
  orderNumber: string;
  batchId: string;
  batchNumber: string;
  batchOrderCount: number;
  packages: number;
  pieces: number;
  weight: number;
  volume: number;
};

const stockBaseSql = `
  FROM transport_orders o
  JOIN customers c ON c.id=o.customer_id
  LEFT JOIN transport_batch_orders bo ON bo.id=(
    SELECT bx.id FROM transport_batch_orders bx
    JOIN transport_batches bb ON bb.id=bx.batch_id AND bb.organization_id=bx.organization_id
    WHERE bx.organization_id=o.organization_id AND bx.order_id=o.id AND bx.status!='removed'
      AND bb.batch_number LIKE 'PZ-%' AND bb.status IN ('planning','loading')
    ORDER BY bb.updated_at DESC LIMIT 1
  )
  LEFT JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=o.organization_id
  LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
  WHERE o.organization_id=? AND EXISTS (
    SELECT 1 FROM warehouse_packages wp JOIN shipments ps ON ps.id=wp.shipment_id
    WHERE wp.organization_id=o.organization_id AND ps.order_id=o.id
      AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')
  )`;

const batchPageBaseSql = `
  FROM transport_batches b
  JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
  JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
  JOIN customers c ON c.id=o.customer_id
  LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
  WHERE b.organization_id=? AND b.warehouse_id=?
    AND b.batch_number LIKE 'PZ-%' AND b.status IN ('planning','loading')`;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;
  if (warehouse.warehouse_role === "overseas_destination")
    throw new Response("境外目的仓不办理拼车装货", { status: 403 });

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const requestedSize =
    Number(url.searchParams.get("pageSize")) || DEFAULT_PAGE_SIZE;
  const pageSize = PAGE_SIZES.includes(requestedSize)
    ? requestedSize
    : DEFAULT_PAGE_SIZE;
  const filters = {
    warehouse: url.searchParams.get("destinationWarehouse")?.trim() ?? "",
    country: url.searchParams.get("country")?.trim() ?? "",
    state: url.searchParams.get("state")?.trim() ?? "",
    city: url.searchParams.get("city")?.trim() ?? "",
    keyword: url.searchParams.get("q")?.trim() ?? "",
  };
  const filterSql: string[] = [];
  const filterBindings: string[] = [];
  const addLike = (column: string, value: string) => {
    if (!value) return;
    filterSql.push(`${column} LIKE ?`);
    filterBindings.push(`%${value}%`);
  };
  addLike("COALESCE(ow.name,'')", filters.warehouse);
  addLike("o.destination_country", filters.country);
  addLike("COALESCE(o.destination_state,'')", filters.state);
  addLike("o.destination_city", filters.city);
  if (filters.keyword) {
    filterSql.push(
      "(o.order_number LIKE ? OR b.batch_number LIKE ? OR c.name LIKE ? OR COALESCE(o.cargo_description,'') LIKE ?)",
    );
    filterBindings.push(...Array(4).fill(`%${filters.keyword}%`));
  }
  const filterClause = filterSql.length
    ? ` AND ${filterSql.join(" AND ")}`
    : "";
  const baseBindings = [user.organizationId, warehouse.id];
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT b.id) total ${batchPageBaseSql}${filterClause}`,
  )
    .bind(...baseBindings, ...filterBindings)
    .first<{ total: number }>();
  const total = totalRow?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);

  const pageBatches = await env.DB.prepare(
    `SELECT b.id
    ${batchPageBaseSql}${filterClause}
    GROUP BY b.id
    ORDER BY MAX(b.updated_at) DESC
    LIMIT ? OFFSET ?`,
  )
    .bind(
      ...baseBindings,
      ...filterBindings,
      pageSize,
      (safePage - 1) * pageSize,
    )
    .all<{ id: string }>();
  const pageBatchIds = pageBatches.results.map((item) => item.id);
  const pageBatchClause = pageBatchIds.length
    ? ` AND b.id IN (${pageBatchIds.map(() => "?").join(",")})`
    : " AND 1=0";

  const [rows, options, tasks, routeOptions] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id batch_id,b.batch_number,b.batch_name,b.warehouse_id batch_warehouse_id,
        COALESCE((SELECT COUNT(*) FROM transport_batch_orders bc WHERE bc.batch_id=b.id AND bc.organization_id=b.organization_id AND bc.status!='removed'),0) batch_order_count,
        o.id order_id,o.order_number,o.business_type,c.name customer_name,
        (SELECT GROUP_CONCAT(NULLIF(TRIM(ci.cargo_name_cn),''),'、') FROM order_cargo_items ci WHERE ci.organization_id=o.organization_id AND ci.order_id=o.id) cargo_names,
        ow.name overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city,b.border_port,b.customs_location,b.planned_departure_at,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments ps ON ps.id=wp.shipment_id WHERE wp.organization_id=o.organization_id AND ps.order_id=o.id AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')) package_count,
        COALESCE((SELECT SUM(wp.pieces) FROM warehouse_packages wp JOIN shipments ps ON ps.id=wp.shipment_id WHERE wp.organization_id=o.organization_id AND ps.order_id=o.id AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')),0) pieces,
        COALESCE((SELECT SUM(wp.weight_kg) FROM warehouse_packages wp JOIN shipments ps ON ps.id=wp.shipment_id WHERE wp.organization_id=o.organization_id AND ps.order_id=o.id AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')),0) weight_kg,
        COALESCE((SELECT SUM(wp.volume_cbm) FROM warehouse_packages wp JOIN shipments ps ON ps.id=wp.shipment_id WHERE wp.organization_id=o.organization_id AND ps.order_id=o.id AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')),0) volume_cbm,
        (SELECT GROUP_CONCAT(DISTINCT wl.name) FROM warehouse_packages wp JOIN shipments ps ON ps.id=wp.shipment_id JOIN warehouse_locations wl ON wl.id=wp.location_id WHERE wp.organization_id=o.organization_id AND ps.order_id=o.id AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')) location_names,
        EXISTS(SELECT 1 FROM warehouse_receipts wr JOIN shipments rs ON rs.id=wr.shipment_id WHERE wr.organization_id=o.organization_id AND rs.order_id=o.id AND wr.warehouse_id=? AND wr.status='completed' AND wr.cargo_complete=1) cargo_ready,
        EXISTS(SELECT 1 FROM warehouse_sorting_batches sb JOIN shipments ss ON ss.id=sb.shipment_id WHERE sb.organization_id=o.organization_id AND ss.order_id=o.id AND sb.status='verified') sorting_ready,
        EXISTS(SELECT 1 FROM warehouse_exceptions we JOIN shipments es ON es.id=we.shipment_id WHERE we.organization_id=o.organization_id AND es.order_id=o.id AND we.status IN ('open','processing')) has_exception,
        EXISTS(SELECT 1 FROM warehouse_dispatch_items di JOIN warehouse_dispatches wd ON wd.id=di.dispatch_id AND wd.status!='cancelled' JOIN warehouse_packages dp ON dp.id=di.package_id JOIN shipments ds ON ds.id=dp.shipment_id WHERE wd.organization_id=o.organization_id AND ds.order_id=o.id AND dp.warehouse_id=?) active_dispatch
      FROM transport_batches b
      JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
      JOIN customers c ON c.id=o.customer_id
      LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
      WHERE b.organization_id=? AND b.warehouse_id=?
        AND b.batch_number LIKE 'PZ-%' AND b.status IN ('planning','loading')${pageBatchClause}
      ORDER BY b.updated_at DESC,bo.sequence_no,o.updated_at DESC`,
    )
      .bind(
        warehouse.id,
        warehouse.id,
        warehouse.id,
        warehouse.id,
        warehouse.id,
        warehouse.id,
        warehouse.id,
        user.organizationId,
        warehouse.id,
        ...pageBatchIds,
      )
      .all<CargoRow>(),
    env.DB.prepare(
      `SELECT DISTINCT COALESCE(ow.name,'') overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city
      ${stockBaseSql}
      ORDER BY overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city`,
    )
      .bind(...baseBindings)
      .all<
        Pick<
          CargoRow,
          | "overseas_warehouse_name"
          | "destination_country"
          | "destination_state"
          | "destination_city"
        >
      >(),
    env.DB.prepare(
      `SELECT d.id,d.dispatch_number,d.transport_batch_id,b.batch_number,
        GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
        GROUP_CONCAT(DISTINCT cargo.cargo_names) cargo_names,
        GROUP_CONCAT(DISTINCT c.name) customer_names,d.destination,d.status,COUNT(DISTINCT di.id) item_count,
        COALESCE(SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END),0) loaded_count,
        COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,
        d.vehicle_plate,d.driver_name,d.carrier_name,d.planned_loading_at,d.created_at
      FROM warehouse_dispatches d JOIN transport_batches b ON b.id=d.transport_batch_id
      LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
      LEFT JOIN warehouse_packages p ON p.id=di.package_id
      LEFT JOIN shipments s ON s.id=p.shipment_id LEFT JOIN transport_orders o ON o.id=s.order_id
      LEFT JOIN customers c ON c.id=o.customer_id
      LEFT JOIN (
        SELECT organization_id,order_id,GROUP_CONCAT(NULLIF(TRIM(cargo_name_cn),''),'、') cargo_names
        FROM order_cargo_items GROUP BY organization_id,order_id
      ) cargo ON cargo.organization_id=o.organization_id AND cargo.order_id=o.id
      WHERE d.organization_id=? AND d.transport_batch_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?)
      GROUP BY d.id ORDER BY d.updated_at DESC LIMIT 30`,
    )
      .bind(user.organizationId, warehouse.id)
      .all<DispatchRow>(),
    env.DB.prepare(
      "SELECT category,code,name FROM reference_data WHERE organization_id=? AND category IN ('border_port','customs_place') AND status='active' ORDER BY category,sort_order,code",
    )
      .bind(user.organizationId)
      .all<ReferenceOption>(),
  ]);

  return {
    user,
    warehouse,
    rows: rows.results,
    options: options.results,
    tasks: tasks.results,
    borderPorts: routeOptions.results.filter(
      (item) => item.category === "border_port",
    ),
    customsPlaces: routeOptions.results.filter(
      (item) => item.category === "customs_place",
    ),
    filters,
    page: safePage,
    pageSize,
    pages,
    total,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(
    request,
    "warehouse.operate",
    "warehouse",
  );
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;
  await requireWarehouseAssignment(user, warehouse.id, "operator");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (intent === "cancel") {
    const dispatchId = valueOf(form, "dispatchId");
    const task = await env.DB.prepare(
      `SELECT d.id,d.dispatch_number,d.transport_batch_id,d.status,
        COALESCE(SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END),0) loaded_count
      FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
      WHERE d.id=? AND d.organization_id=? AND d.transport_batch_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?)
      GROUP BY d.id`,
    )
      .bind(dispatchId, user.organizationId, warehouse.id)
      .first<{
        id: string;
        dispatch_number: string;
        transport_batch_id: string;
        status: string;
        loaded_count: number;
      }>();
    if (!task) return { formError: "装车任务不存在" };
    if (task.status !== "loading")
      return { formError: "只有尚未完成的装车任务可以撤销" };
    if (task.loaded_count > 0)
      return {
        formError: "该任务已经开始扫码装车，不能撤销；请先按异常流程处理",
      };
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE warehouse_packages SET status='in_stock',updated_at=? WHERE organization_id=? AND status='allocated' AND id IN (SELECT package_id FROM warehouse_dispatch_items WHERE dispatch_id=?)",
      ).bind(now, user.organizationId, task.id),
      env.DB.prepare(
        "UPDATE warehouse_dispatches SET status='cancelled',updated_at=? WHERE id=?",
      ).bind(now, task.id),
      env.DB.prepare(
        "UPDATE transport_batches SET status='planning',road_status='waiting_loading',updated_at=? WHERE id=? AND organization_id=? AND status='loading'",
      ).bind(now, task.transport_batch_id, user.organizationId),
    ]);
    await writeAudit({
      request,
      action: "warehouse.ltl_loading.cancel",
      resourceType: "warehouse_dispatch",
      resourceId: task.id,
      organizationId: user.organizationId,
      actorUserId: user.userId,
      metadata: {
        dispatchNumber: task.dispatch_number,
        transportBatchId: task.transport_batch_id,
      },
    });
    return {
      success: `装车任务 ${task.dispatch_number} 已撤销，整批货物已释放`,
    };
  }

  if (intent === "route") {
    const batchId = valueOf(form, "batchId");
    const borderPort = valueOf(form, "borderPort").trim();
    const customsLocation = valueOf(form, "customsLocation").trim();
    if (!batchId) return { formError: "请先选择一张 PZ 配载单" };
    if (!borderPort || !customsLocation)
      return { formError: "请选择出境口岸和清关地" };
    const batch = await env.DB.prepare(
      `SELECT b.id,b.batch_number,b.warehouse_id,
        EXISTS(SELECT 1 FROM warehouse_dispatches d WHERE d.organization_id=b.organization_id AND d.transport_batch_id=b.id AND d.status!='cancelled') has_dispatch
      FROM transport_batches b
      WHERE b.id=? AND b.organization_id=? AND b.batch_number LIKE 'PZ-%' AND b.status IN ('planning','loading')`,
    )
      .bind(batchId, user.organizationId)
      .first<{
        id: string;
        batch_number: string;
        warehouse_id: string | null;
        has_dispatch: number;
      }>();
    if (!batch || batch.warehouse_id !== warehouse.id)
      return { formError: "配载单不存在或不属于当前仓库" };
    if (batch.has_dispatch)
      return {
        formError: `${batch.batch_number} 已生成装车任务，不能再修改口岸和清关地`,
      };
    const references = await env.DB.prepare(
      `SELECT category,code FROM reference_data
      WHERE organization_id=? AND status='active' AND ((category='border_port' AND code=?) OR (category='customs_place' AND code=?))`,
    )
      .bind(user.organizationId, borderPort, customsLocation)
      .all<{ category: string; code: string }>();
    if (
      !references.results.some(
        (item) => item.category === "border_port" && item.code === borderPort,
      )
    )
      return { formError: "请选择基础数据中启用的出境口岸" };
    if (
      !references.results.some(
        (item) =>
          item.category === "customs_place" && item.code === customsLocation,
      )
    )
      return { formError: "请选择基础数据中启用的清关地" };
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE transport_batches SET border_port=?,customs_location=?,updated_at=? WHERE id=? AND organization_id=?",
      ).bind(borderPort, customsLocation, now, batch.id, user.organizationId),
      env.DB.prepare(
        `UPDATE transport_orders SET exit_port=?,customs_location=?,updated_at=?
        WHERE organization_id=? AND id IN (
          SELECT order_id FROM transport_batch_orders WHERE batch_id=? AND organization_id=? AND status!='removed'
        )`,
      ).bind(
        borderPort,
        customsLocation,
        now,
        user.organizationId,
        batch.id,
        user.organizationId,
      ),
    ]);
    await writeAudit({
      request,
      action: "warehouse.ltl_loading.route",
      resourceType: "transport_batch",
      resourceId: batch.id,
      organizationId: user.organizationId,
      actorUserId: user.userId,
      metadata: {
        batchNumber: batch.batch_number,
        borderPort,
        customsLocation,
      },
    });
    return {
      success: `${batch.batch_number} 的出境口岸和清关地已保存`,
      routeSaved: true,
    };
  }

  if (intent !== "create") return { formError: "未知操作" };
  const batchId = valueOf(form, "batchId");
  const plannedDepartureAt = valueOf(form, "plannedDepartureAt").trim();
  const selectedOrderIds = [
    ...new Set(form.getAll("orderId").map(String).filter(Boolean)),
  ];
  if (!batchId || !selectedOrderIds.length)
    return { formError: "请先选择一张配载单内的全部订单" };
  if (!plannedDepartureAt)
    return { formError: "请填写计划出境发车时间" };
  const batch = await env.DB.prepare(
    `SELECT id,batch_number,batch_name,destination_location,status,warehouse_id,border_port,customs_location,planned_departure_at
    FROM transport_batches WHERE id=? AND organization_id=? AND batch_number LIKE 'PZ-%' AND status IN ('planning','loading')`,
  )
    .bind(batchId, user.organizationId)
    .first<{
      id: string;
      batch_number: string;
      batch_name: string;
      destination_location: string;
      status: string;
      warehouse_id: string | null;
      border_port: string | null;
      customs_location: string | null;
      planned_departure_at: string | null;
    }>();
  if (!batch) return { formError: "PZ 配载单不存在或已不能生成装车任务" };
  if (batch.warehouse_id !== warehouse.id)
    return { formError: `配载单 ${batch.batch_number} 不属于当前仓库` };
  if (!batch.border_port || !batch.customs_location)
    return { formError: `请先为 ${batch.batch_number} 选择出境口岸和清关地` };
  const orders = await env.DB.prepare(
    `SELECT bo.order_id,o.order_number,o.business_type
    FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
    WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`,
  )
    .bind(batch.id, user.organizationId)
    .all<{ order_id: string; order_number: string; business_type: string }>();
  const expected = orders.results.map((item) => item.order_id).sort();
  const selected = [...selectedOrderIds].sort();
  if (
    expected.length !== selected.length ||
    expected.some((id, index) => id !== selected[index])
  )
    return {
      formError: `必须整批选择 ${batch.batch_number} 的全部 ${expected.length} 票订单，仓库不能改变配载关系`,
    };
  if (orders.results.some((item) => item.business_type !== "ltl"))
    return { formError: "该配载单混入了非拼车订单，请回操作端修正" };

  const blockers: string[] = [];
  for (const order of orders.results) {
    const state = await env.DB.prepare(
      `SELECT
        EXISTS(SELECT 1 FROM warehouse_receipts wr JOIN shipments s ON s.id=wr.shipment_id WHERE wr.organization_id=? AND s.order_id=? AND wr.warehouse_id=? AND wr.status='completed' AND wr.cargo_complete=1) cargo_ready,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s ON s.id=wp.shipment_id WHERE wp.organization_id=? AND s.order_id=? AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')) package_count,
        EXISTS(SELECT 1 FROM warehouse_sorting_batches sb JOIN shipments s ON s.id=sb.shipment_id WHERE sb.organization_id=? AND s.order_id=? AND sb.status='verified') sorting_ready,
        EXISTS(SELECT 1 FROM warehouse_exceptions we JOIN shipments s ON s.id=we.shipment_id WHERE we.organization_id=? AND s.order_id=? AND we.status IN ('open','processing')) has_exception`,
    )
      .bind(
        user.organizationId,
        order.order_id,
        warehouse.id,
        user.organizationId,
        order.order_id,
        warehouse.id,
        user.organizationId,
        order.order_id,
        user.organizationId,
        order.order_id,
      )
      .first<{
        cargo_ready: number;
        package_count: number;
        sorting_ready: number;
        has_exception: number;
      }>();
    const reasons: string[] = [];
    if (!state?.cargo_ready) reasons.push("未确认货齐");
    if (!state?.package_count) reasons.push("当前仓无在库货物");
    if (!state?.sorting_ready) reasons.push("未形成可装车货号");
    if (state?.has_exception) reasons.push("存在未结异常");
    if (reasons.length)
      blockers.push(`${order.order_number}：${reasons.join("、")}`);
  }
  if (blockers.length)
    return { formError: `整批暂不能生成装车任务：${blockers.join("；")}` };

  const existingActive = await env.DB.prepare(
    "SELECT dispatch_number FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status!='cancelled' LIMIT 1",
  )
    .bind(user.organizationId, batch.id)
    .first<{ dispatch_number: string }>();
  if (existingActive)
    return {
      formError: `配载单 ${batch.batch_number} 已生成装车任务 ${existingActive.dispatch_number}`,
    };
  const representative = await env.DB.prepare(
    `SELECT sb.id,sb.shipment_id FROM warehouse_sorting_batches sb JOIN shipments s ON s.id=sb.shipment_id
    WHERE sb.organization_id=? AND s.order_id=? AND sb.status='verified' ORDER BY sb.verified_at DESC LIMIT 1`,
  )
    .bind(user.organizationId, orders.results[0].order_id)
    .first<{ id: string; shipment_id: string }>();
  if (!representative)
    return {
      formError: `${orders.results[0].order_number} 尚未形成可装车货号`,
    };
  const occupied = await env.DB.prepare(
    `SELECT o.order_number,d.dispatch_number FROM transport_batch_orders bo
    JOIN shipments s ON s.order_id=bo.order_id JOIN warehouse_packages p ON p.shipment_id=s.id AND p.warehouse_id=?
    JOIN warehouse_dispatch_items di ON di.package_id=p.id JOIN warehouse_dispatches d ON d.id=di.dispatch_id AND d.status!='cancelled'
    JOIN transport_orders o ON o.id=bo.order_id WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' LIMIT 1`,
  )
    .bind(warehouse.id, batch.id, user.organizationId)
    .first<{ order_number: string; dispatch_number: string }>();
  if (occupied)
    return {
      formError: `${occupied.order_number} 已被装车任务 ${occupied.dispatch_number} 占用`,
    };

  const vehicles = await env.DB.prepare(
    `SELECT v.plate_number,v.driver_name,v.driver_phone,COALESCE(c.name,bc.name) carrier_name
    FROM transport_batch_vehicles v JOIN transport_batches b ON b.id=v.batch_id
    LEFT JOIN carriers c ON c.id=v.carrier_id LEFT JOIN carriers bc ON bc.id=b.carrier_id
    WHERE v.batch_id=? AND v.organization_id=? AND v.status!='cancelled' ORDER BY v.created_at LIMIT 2`,
  )
    .bind(batch.id, user.organizationId)
    .all<{
      plate_number: string | null;
      driver_name: string | null;
      driver_phone: string | null;
      carrier_name: string | null;
    }>();
  const resource = vehicles.results.length === 1 ? vehicles.results[0] : null;
  const cancelled = await env.DB.prepare(
    "SELECT id,dispatch_number FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='cancelled' ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(user.organizationId, batch.id)
    .first<{ id: string; dispatch_number: string }>();
  const dispatchId = cancelled?.id ?? crypto.randomUUID();
  const dispatchNumber =
    cancelled?.dispatch_number ??
    `OUT-${now.slice(2, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
  const plannedLoadingAt = valueOf(form, "plannedLoadingAt") || null;
  const notes = valueOf(form, "notes").trim() || null;
  const statements: D1PreparedStatement[] = [];
  if (cancelled) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM warehouse_dispatch_items WHERE dispatch_id=?",
      ).bind(dispatchId),
      env.DB.prepare(
        `UPDATE warehouse_dispatches SET sorting_batch_id=?,shipment_id=?,vehicle_plate=?,driver_name=?,driver_phone=?,carrier_name=?,seal_number=NULL,destination=?,status='loading',notes=?,created_by_user_id=?,dispatched_by_user_id=NULL,dispatched_at=NULL,planned_loading_at=?,updated_at=? WHERE id=?`,
      ).bind(
        representative.id,
        representative.shipment_id,
        resource?.plate_number?.trim().toUpperCase() || "",
        resource?.driver_name?.trim() || "",
        resource?.driver_phone?.trim() || null,
        resource?.carrier_name?.trim() || null,
        batch.destination_location,
        notes,
        user.userId,
        plannedLoadingAt,
        now,
        dispatchId,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO warehouse_dispatches(id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,driver_name,driver_phone,carrier_name,seal_number,destination,status,notes,created_by_user_id,created_at,updated_at,transport_batch_id,planned_loading_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,'loading',?,?,?,?,?,?)`,
      ).bind(
        dispatchId,
        user.organizationId,
        dispatchNumber,
        representative.id,
        representative.shipment_id,
        resource?.plate_number?.trim().toUpperCase() || "",
        resource?.driver_name?.trim() || "",
        resource?.driver_phone?.trim() || null,
        resource?.carrier_name?.trim() || null,
        batch.destination_location,
        notes,
        user.userId,
        now,
        now,
        batch.id,
        plannedLoadingAt,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status)
      SELECT lower(hex(randomblob(16))),p.organization_id,?,p.id,'pending'
      FROM transport_batch_orders bo JOIN shipments s ON s.order_id=bo.order_id AND s.organization_id=bo.organization_id
      JOIN warehouse_packages p ON p.shipment_id=s.id AND p.organization_id=s.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')`,
    ).bind(dispatchId, batch.id, user.organizationId, warehouse.id),
    env.DB.prepare(
      `UPDATE warehouse_packages SET status='allocated',updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='in_stock'
      AND shipment_id IN (SELECT s.id FROM transport_batch_orders bo JOIN shipments s ON s.order_id=bo.order_id AND s.organization_id=bo.organization_id WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed')`,
    ).bind(
      now,
      user.organizationId,
      warehouse.id,
      batch.id,
      user.organizationId,
    ),
    env.DB.prepare(
      "UPDATE transport_batches SET status='loading',road_status='waiting_loading',planned_departure_at=?,updated_at=? WHERE id=? AND organization_id=?",
    ).bind(plannedDepartureAt, now, batch.id, user.organizationId),
  );
  await env.DB.batch(statements);
  await writeAudit({
    request,
    action: "warehouse.ltl_loading.create",
    resourceType: "warehouse_dispatch",
    resourceId: dispatchId,
    organizationId: user.organizationId,
    actorUserId: user.userId,
    metadata: {
      dispatchNumber,
      batchNumber: batch.batch_number,
      orderIds: selectedOrderIds,
      vehicleInherited: Boolean(resource),
    },
  });
  return {
    success: `装车任务 ${dispatchNumber} 已生成；整批 ${orders.results.length} 票货物已锁定`,
  };
}

export default function WarehouseLtlLoading({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const storageKey = `warehouse-ltl-loading:${loaderData.warehouse.id}`;
  const [selected, setSelected] = useState<Selection[]>([]);
  useEffect(() => {
    try {
      setSelected(JSON.parse(localStorage.getItem(storageKey) || "[]"));
    } catch {
      setSelected([]);
    }
  }, [storageKey]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(selected));
  }, [storageKey, selected]);
  useEffect(() => {
    if (
      actionData?.success &&
      !("routeSaved" in actionData && actionData.routeSaved)
    )
      setSelected([]);
  }, [actionData?.success]);
  const selectedBatchId = selected[0]?.batchId ?? "";
  const selectedBatch = loaderData.rows.find(
    (row) => row.batch_id === selectedBatchId,
  );
  const batchGroups = useMemo(() => {
    const groups = new Map<string, CargoRow[]>();
    for (const row of loaderData.rows) {
      if (!row.batch_id) continue;
      const group = groups.get(row.batch_id) ?? [];
      group.push(row);
      groups.set(row.batch_id, group);
    }
    return [...groups.entries()].map(([batchId, rows]) => ({
      batchId,
      rows,
      lead: rows[0],
    }));
  }, [loaderData.rows]);
  const totals = useMemo(
    () =>
      selected.reduce(
        (sum, item) => ({
          packages: sum.packages + item.packages,
          pieces: sum.pieces + item.pieces,
          weight: sum.weight + item.weight,
          volume: sum.volume + item.volume,
        }),
        { packages: 0, pieces: 0, weight: 0, volume: 0 },
      ),
    [selected],
  );
  const selectBatch = (batchRows: CargoRow[], checked: boolean) => {
    const lead = batchRows[0];
    if (!lead?.batch_id || !lead.batch_number) return;
    if (!checked) {
      setSelected((current) =>
        current.filter((item) => item.batchId !== lead.batch_id),
      );
      return;
    }
    if (selectedBatchId && selectedBatchId !== lead.batch_id) return;
    if (
      batchRows.some(
        (row) => stockBlockers(row, loaderData.warehouse.id).length > 0,
      )
    )
      return;
    setSelected(
      batchRows.map((row) => ({
        orderId: row.order_id,
        orderNumber: row.order_number,
        batchId: lead.batch_id!,
        batchNumber: lead.batch_number!,
        batchOrderCount: lead.batch_order_count,
        packages: row.package_count,
        pieces: row.pieces,
        weight: row.weight_kg,
        volume: row.volume_cbm,
      })),
    );
  };
  const optionValues = <K extends keyof (typeof loaderData.options)[number]>(
    key: K,
  ) => [
    ...new Set(
      loaderData.options.map((item) => item[key]).filter(Boolean) as string[],
    ),
  ];
  return (
    <div className="warehouse-ltl-loading-page">
      <header className="warehouse-page-header ltl-loading-header">
        <div>
          <p className="eyebrow">LTL LOADING</p>
          <h1>拼车装货</h1>
          <p>在配载单所在行确定出境口岸与清关地，再按整批生成装车任务。</p>
        </div>
        <div className="page-actions ltl-loading-actions" hidden>
          {selectedBatchId ? (
            <Modal
              title={`选择口岸与清关 · ${selected[0].batchNumber}`}
              triggerLabel={
                selectedBatch?.border_port && selectedBatch?.customs_location
                  ? "修改口岸与清关"
                  : "选择口岸与清关"
              }
              triggerClassName="secondary"
              size="wide"
              closeSignal={actionData?.success}
            >
              <Form method="post" className="stack ltl-route-form">
                <input type="hidden" name="intent" value="route" />
                <input type="hidden" name="batchId" value={selectedBatchId} />
                <div className="ltl-route-context">
                  <span>当前配载单</span>
                  <strong>{selected[0].batchNumber}</strong>
                  <small>
                    {selected.length}/{selected[0].batchOrderCount} 票已选
                  </small>
                </div>
                <div className="form-grid compact">
                  <label className="field">
                    <span>出境口岸 *</span>
                    <select
                      name="borderPort"
                      defaultValue={selectedBatch?.border_port || ""}
                      required
                    >
                      <option value="">请选择出境口岸</option>
                      {loaderData.borderPorts.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name} · {item.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>清关地 *</span>
                    <select
                      name="customsLocation"
                      defaultValue={selectedBatch?.customs_location || ""}
                      required
                    >
                      <option value="">请选择清关地</option>
                      {loaderData.customsPlaces.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name} · {item.code}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="alert info">
                  保存后同步到该配载单的全部订单；生成装车任务前仍可修改。
                </div>
                <button className="primary warehouse-primary" disabled={busy}>
                  保存口岸与清关地
                </button>
              </Form>
            </Modal>
          ) : (
            <button type="button" className="secondary" disabled>
              选择口岸与清关
            </button>
          )}
          <Modal
            title="生成拼车装车任务"
            triggerLabel={`生成装车任务${selected.length ? `（${selected.length} 票）` : ""}`}
            size="xwide"
            closeSignal={actionData?.success}
          >
            <Form method="post" className="stack ltl-task-form">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="batchId" value={selectedBatchId} />
              {selected.map((item) => (
                <input
                  key={item.orderId}
                  type="hidden"
                  name="orderId"
                  value={item.orderId}
                />
              ))}
              {!selected.length ? (
                <div className="alert">
                  请先从列表选择一张 PZ 配载单内的全部订单。
                </div>
              ) : (
                <>
                  <div className="ltl-selection-summary">
                    <div>
                      <span>配载单</span>
                      <strong>{selected[0].batchNumber}</strong>
                    </div>
                    <div>
                      <span>已选订单</span>
                      <strong>
                        {selected.length}/{selected[0].batchOrderCount} 票
                      </strong>
                    </div>
                    <div>
                      <span>包装 / 件数</span>
                      <strong>
                        {totals.packages} 包装 · {totals.pieces} 件
                      </strong>
                    </div>
                    <div>
                      <span>实收重量 / 体积</span>
                      <strong>
                        {totals.weight.toFixed(2)} KG ·{" "}
                        {totals.volume.toFixed(3)} CBM
                      </strong>
                    </div>
                  </div>
                  <div className="ltl-route-summary">
                    <div>
                      <span>出境口岸</span>
                      <strong>
                        {selectedBatch?.border_port || "尚未选择"}
                      </strong>
                    </div>
                    <div>
                      <span>清关地</span>
                      <strong>
                        {selectedBatch?.customs_location || "尚未选择"}
                      </strong>
                    </div>
                  </div>
                  <div className="table-wrap compact-selection-table">
                    <table>
                      <thead>
                        <tr>
                          <th>订单</th>
                          <th>包装</th>
                          <th>重量</th>
                          <th>体积</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.map((item) => (
                          <tr key={item.orderId}>
                            <td>{item.orderNumber}</td>
                            <td>{item.packages}</td>
                            <td>{item.weight.toFixed(2)} KG</td>
                            <td>{item.volume.toFixed(3)} CBM</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="form-grid compact">
                    <label className="field">
                      <span>计划装车时间</span>
                      <input type="datetime-local" name="plannedLoadingAt" />
                    </label>
                    <label className="field span-2">
                      <span>装车备注</span>
                      <textarea
                        name="notes"
                        rows={2}
                        placeholder="选填；车辆、司机和承运商可在配载单中后补"
                      />
                    </label>
                  </div>
                  <div className="alert info">
                    仓库不能增删配载订单。车辆资源可以后补，但扫码装车和完成出库前必须补齐。
                  </div>
                </>
              )}
              <button
                className="primary warehouse-primary"
                disabled={
                  busy ||
                  !selected.length ||
                  selected.length !== selected[0]?.batchOrderCount
                }
              >
                确认生成整批装车任务
              </button>
            </Form>
          </Modal>
        </div>
      </header>
      {actionData?.formError && (
        <div className="alert error">{actionData.formError}</div>
      )}
      {actionData?.success && (
        <div className="alert success">{actionData.success}</div>
      )}
      <section className="panel ltl-filter-panel">
        <Form method="get" className="ltl-loading-filters">
          <input
            type="hidden"
            name="warehouseId"
            value={loaderData.warehouse.id}
          />
          <label>
            <span>目的仓</span>
            <select
              name="destinationWarehouse"
              defaultValue={loaderData.filters.warehouse}
            >
              <option value="">全部</option>
              {optionValues("overseas_warehouse_name").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>国家</span>
            <select name="country" defaultValue={loaderData.filters.country}>
              <option value="">全部</option>
              {optionValues("destination_country").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>省 / 州</span>
            <select name="state" defaultValue={loaderData.filters.state}>
              <option value="">全部</option>
              {optionValues("destination_state").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>城市</span>
            <select name="city" defaultValue={loaderData.filters.city}>
              <option value="">全部</option>
              {optionValues("destination_city").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="ltl-filter-search">
            <span>快速查找</span>
            <input
              name="q"
              defaultValue={loaderData.filters.keyword}
              placeholder="订单、配载单、客户或货物"
            />
          </label>
          <label>
            <span>每页</span>
            <select name="pageSize" defaultValue={loaderData.pageSize}>
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} 条
                </option>
              ))}
            </select>
          </label>
          <button className="secondary ltl-filter-submit">筛选</button>
          <LoadingTaskModal
            selected={selected}
            selectedBatch={selectedBatch}
            totals={totals}
            busy={busy}
            closeSignal={actionData?.success}
          />
          <Link
            className="text-button ltl-filter-reset"
            to={`/warehouse/ltl-loading?warehouseId=${loaderData.warehouse.id}`}
          >
            重置
          </Link>
        </Form>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>当前仓库待装车配载单</h2>
            <p>
              同一张 PZ 配载单的全部订单集中显示；勾选一次即可整批生成装车任务。
            </p>
          </div>
          <span className="status-pill">{loaderData.total} 张配载单</span>
        </div>
        <div className="table-wrap ltl-loading-table">
          <table className="ltl-task-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>装货状态</th>
                <th>配载单</th>
                <th>订单 / 客户</th>
                <th>货物</th>
                <th>实收数据</th>
                <th>目的地</th>
                <th>口岸 / 清关</th>
                <th>库位</th>
              </tr>
            </thead>
            <tbody>
              {batchGroups.map(({ batchId, rows, lead }) => {
                const blockedOrders = rows.flatMap((row) =>
                  stockBlockers(row, loaderData.warehouse.id).map(
                    (reason) => `${row.order_number}：${reason}`,
                  ),
                );
                const selectedOrderIds = new Set(
                  selected
                    .filter((item) => item.batchId === batchId)
                    .map((item) => item.orderId),
                );
                const checked = rows.every((row) =>
                  selectedOrderIds.has(row.order_id),
                );
                const batchMismatch = Boolean(
                  selectedBatchId && selectedBatchId !== batchId,
                );
                const disabled = blockedOrders.length > 0 || batchMismatch;
                const batchTotals = rows.reduce(
                  (sum, row) => ({
                    packages: sum.packages + row.package_count,
                    pieces: sum.pieces + row.pieces,
                    weight: sum.weight + row.weight_kg,
                    volume: sum.volume + row.volume_cbm,
                  }),
                  { packages: 0, pieces: 0, weight: 0, volume: 0 },
                );
                const locations = [
                  ...new Set(
                    rows.flatMap((row) =>
                      (row.location_names || "")
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    ),
                  ),
                ];
                return (
                  <tr key={batchId} className={checked ? "selected-row" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(event) =>
                          selectBatch(rows, event.target.checked)
                        }
                        aria-label={`整批选择配载单 ${lead.batch_number}`}
                      />
                      <small>整批</small>
                    </td>
                    <td>
                      {blockedOrders.length ? (
                        <>
                          <span className="status-pill off">暂不可装车</span>
                          <small className="danger-text">
                            {blockedOrders.join("；")}
                          </small>
                        </>
                      ) : (
                        <>
                          <span className="status-pill success">
                            整批可装车
                          </span>
                          <small>勾选一次即选择全部货物</small>
                        </>
                      )}
                    </td>
                    <td>
                      <strong>{lead.batch_number}</strong>
                      <small>{rows.length} 票订单 · 同一装车任务</small>
                    </td>
                    <td>
                      <div className="ltl-batch-order-list">
                        {rows.map((row) => (
                          <div key={row.order_id}>
                            <strong>{row.order_number}</strong>
                            <small>{row.customer_name}</small>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="ltl-batch-cargo-list">
                        {rows.map((row) => (
                          <div key={row.order_id}>
                            <strong>{row.cargo_names || "未填写货名"}</strong>
                            <small>{row.order_number}</small>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td>
                      {batchTotals.packages} 包装 · {batchTotals.pieces} 件
                      <small>
                        {batchTotals.weight.toFixed(2)} KG ·{" "}
                        {batchTotals.volume.toFixed(3)} CBM
                      </small>
                    </td>
                    <td>
                      {lead.overseas_warehouse_name || "目的仓未命名"}
                      <small>
                        {[
                          lead.destination_country,
                          lead.destination_state,
                          lead.destination_city,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      </small>
                    </td>
                    <td>
                      <div className="ltl-route-cell">
                        <Modal
                          title={`口岸与清关 · ${lead.batch_number}`}
                          triggerLabel={lead.border_port || "未填口岸"}
                          triggerClassName={`ltl-route-cell-button ${lead.border_port ? "configured" : "missing"}`}
                          size="wide"
                          closeSignal={actionData?.success}
                        >
                          <Form method="post" className="stack ltl-route-form">
                            <input type="hidden" name="intent" value="route" />
                            <input
                              type="hidden"
                              name="batchId"
                              value={batchId}
                            />
                            <div className="ltl-route-context">
                              <span>当前配载单</span>
                              <strong>{lead.batch_number}</strong>
                              <small>{rows.length} 票订单</small>
                            </div>
                            <div className="form-grid compact">
                              <label className="field">
                                <span>出境口岸 *</span>
                                <select
                                  name="borderPort"
                                  defaultValue={lead.border_port || ""}
                                  required
                                >
                                  <option value="">请选择出境口岸</option>
                                  {loaderData.borderPorts.map((item) => (
                                    <option key={item.code} value={item.code}>
                                      {item.name} · {item.code}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="field">
                                <span>清关地 *</span>
                                <select
                                  name="customsLocation"
                                  defaultValue={lead.customs_location || ""}
                                  required
                                >
                                  <option value="">请选择清关地</option>
                                  {loaderData.customsPlaces.map((item) => (
                                    <option key={item.code} value={item.code}>
                                      {item.name} · {item.code}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="alert info">
                              保存后同步到该配载单全部订单；生成装车任务前仍可修改。
                            </div>
                            <button
                              className="primary warehouse-primary"
                              disabled={busy}
                            >
                              保存口岸与清关地
                            </button>
                          </Form>
                        </Modal>
                        <small>{lead.customs_location || "未填清关地"}</small>
                      </div>
                    </td>
                    <td>{locations.join("、") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!batchGroups.length && (
          <p className="empty-state">
            当前仓库没有符合筛选条件的待装车配载单。
          </p>
        )}
        <Pagination loaderData={loaderData} />
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>最近拼车装货任务</h2>
            <p>待装车任务可进入扫码出库；尚未扫码的任务可以撤销。</p>
          </div>
          <Link
            className="secondary"
            to={`/warehouse/outbound?warehouseId=${loaderData.warehouse.id}`}
          >
            进入扫码装车与出库
          </Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务 / 配载单</th>
                <th>订单</th>
                <th>实收汇总</th>
                <th>装车进度</th>
                <th>车辆资源</th>
                <th>计划装车</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <strong>{task.dispatch_number}</strong>
                    <small>{task.batch_number} · 装车任务号</small>
                    <small
                      className="dispatch-task-summary"
                      title={`订单：${task.order_numbers || "—"}；货物：${task.cargo_names || "—"}；客户：${task.customer_names || "—"}；目的地：${task.destination || "—"}`}
                    >
                      订单：{task.order_numbers || "—"} · 货物：
                      {task.cargo_names || "—"} · 客户：
                      {task.customer_names || "—"} · 目的地：
                      {task.destination || "—"}
                    </small>
                  </td>
                  <td>{task.order_numbers}</td>
                  <td>
                    {task.weight_kg.toFixed(2)} KG
                    <small>{task.volume_cbm.toFixed(3)} CBM</small>
                  </td>
                  <td>
                    {task.loaded_count}/{task.item_count}
                  </td>
                  <td>
                    {task.vehicle_plate || "待补车辆"}
                    <small>
                      {task.carrier_name || "待补承运商"} ·{" "}
                      {task.driver_name || "待补司机"}
                    </small>
                  </td>
                  <td>
                    {task.planned_loading_at
                      ? new Date(task.planned_loading_at).toLocaleString(
                          "zh-CN",
                        )
                      : "待定"}
                  </td>
                  <td>
                    <span
                      className={`status-pill ${task.status === "cancelled" ? "off" : ""}`}
                    >
                      {task.status === "loading"
                        ? "待装车"
                        : task.status === "dispatched"
                          ? "已出库"
                          : "已撤销"}
                    </span>
                  </td>
                  <td>
                    <div className="button-row">
                      {task.status === "loading" && (
                        <Link
                          className="text-button"
                          to={`/warehouse/outbound?warehouseId=${loaderData.warehouse.id}`}
                        >
                          去装车
                        </Link>
                      )}
                      {task.status === "loading" && task.loaded_count === 0 && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="cancel" />
                          <input
                            type="hidden"
                            name="dispatchId"
                            value={task.id}
                          />
                          <button
                            className="text-button danger"
                            disabled={busy}
                          >
                            撤销
                          </button>
                        </Form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loaderData.tasks.length && (
          <p className="empty-state">暂无拼车装货任务。</p>
        )}
      </section>
    </div>
  );
}

function LoadingTaskModal({
  selected,
  selectedBatch,
  totals,
  busy,
  closeSignal,
}: {
  selected: Selection[];
  selectedBatch: CargoRow | undefined;
  totals: {
    packages: number;
    pieces: number;
    weight: number;
    volume: number;
  };
  busy: boolean;
  closeSignal?: unknown;
}) {
  return (
    <Modal
      title="生成拼车装车任务"
      triggerLabel={`生成装车任务${selected.length ? `（${selected.length} 票）` : ""}`}
      triggerClassName="primary warehouse-primary ltl-generate-task-trigger"
      size="xwide"
      closeSignal={closeSignal}
    >
      <Form method="post" className="stack ltl-task-form">
        <input type="hidden" name="intent" value="create" />
        <input
          type="hidden"
          name="batchId"
          value={selected[0]?.batchId || ""}
        />
        {selected.map((item) => (
          <input
            key={item.orderId}
            type="hidden"
            name="orderId"
            value={item.orderId}
          />
        ))}
        {!selected.length ? (
          <div className="alert">
            请先从列表选择一张 PZ 配载单内的全部订单。
          </div>
        ) : (
          <>
            <div className="ltl-selection-summary">
              <div>
                <span>配载单</span>
                <strong>{selected[0].batchNumber}</strong>
              </div>
              <div>
                <span>已选订单</span>
                <strong>
                  {selected.length}/{selected[0].batchOrderCount} 票
                </strong>
              </div>
              <div>
                <span>包装 / 件数</span>
                <strong>
                  {totals.packages} 包装 · {totals.pieces} 件
                </strong>
              </div>
              <div>
                <span>实收重量 / 体积</span>
                <strong>
                  {totals.weight.toFixed(2)} KG · {totals.volume.toFixed(3)} CBM
                </strong>
              </div>
            </div>
            <div className="ltl-route-summary">
              <div>
                <span>出境口岸</span>
                <strong>{selectedBatch?.border_port || "尚未选择"}</strong>
              </div>
              <div>
                <span>清关地</span>
                <strong>{selectedBatch?.customs_location || "尚未选择"}</strong>
              </div>
            </div>
            <div className="table-wrap compact-selection-table">
              <table>
                <thead>
                  <tr>
                    <th>订单</th>
                    <th>包装</th>
                    <th>重量</th>
                    <th>体积</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.map((item) => (
                    <tr key={item.orderId}>
                      <td>{item.orderNumber}</td>
                      <td>{item.packages}</td>
                      <td>{item.weight.toFixed(2)} KG</td>
                      <td>{item.volume.toFixed(3)} CBM</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-grid compact">
              <label className="field">
                <span>计划出境发车时间 *</span>
                <input
                  type="datetime-local"
                  name="plannedDepartureAt"
                  defaultValue={selectedBatch?.planned_departure_at?.slice(
                    0,
                    16,
                  )}
                  required
                />
              </label>
              <label className="field">
                <span>计划装车时间</span>
                <input type="datetime-local" name="plannedLoadingAt" />
              </label>
              <label className="field span-2">
                <span>装车备注</span>
                <textarea
                  name="notes"
                  rows={2}
                  placeholder="选填；车辆、司机和承运商可在配载单中后补"
                />
              </label>
            </div>
            <div className="alert info">
              仓库不能增删配载订单。车辆资源可以后补，但扫码装车和完成出库前必须补齐。
            </div>
          </>
        )}
        <button
          className="primary warehouse-primary"
          disabled={
            busy ||
            !selected.length ||
            selected.length !== selected[0]?.batchOrderCount
          }
        >
          确认生成整批装车任务
        </button>
      </Form>
    </Modal>
  );
}

function Pagination({
  loaderData,
}: {
  loaderData: {
    page: number;
    pages: number;
    pageSize: number;
    warehouse: { id: string };
    filters: Record<string, string>;
  };
}) {
  if (loaderData.pages <= 1) return null;
  const href = (page: number) => {
    const params = new URLSearchParams({
      warehouseId: loaderData.warehouse.id,
      page: String(page),
      pageSize: String(loaderData.pageSize),
    });
    Object.entries(loaderData.filters).forEach(([key, value]) => {
      const names: Record<string, string> = {
        warehouse: "destinationWarehouse",
        keyword: "q",
      };
      if (value) params.set(names[key] || key, value);
    });
    return `/warehouse/ltl-loading?${params}`;
  };
  return (
    <footer className="pagination">
      <span>
        第 {loaderData.page} / {loaderData.pages} 页
      </span>
      <div>
        {loaderData.page > 1 && (
          <Link className="secondary" to={href(loaderData.page - 1)}>
            上一页
          </Link>
        )}
        {loaderData.page < loaderData.pages && (
          <Link className="secondary" to={href(loaderData.page + 1)}>
            下一页
          </Link>
        )}
      </div>
    </footer>
  );
}

export function meta() {
  return [{ title: "拼车装货 | International TMS" }];
}

function stockBlockers(row: CargoRow, warehouseId: string) {
  const reasons: string[] = [];
  if (row.business_type !== "ltl") reasons.push("整车订单不走拼车装货");
  if (!row.batch_id) reasons.push("未生成 PZ 配载单");
  else if (row.batch_warehouse_id !== warehouseId)
    reasons.push("配载单所属仓库不一致");
  if (!row.cargo_ready) reasons.push("尚未确认货齐");
  if (!row.sorting_ready) reasons.push("尚未形成可装车货号");
  if (row.has_exception) reasons.push("存在未结仓库异常");
  if (row.active_dispatch) reasons.push("已进入装车任务");
  return reasons;
}
