import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.carriers";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { validatePhone, valueOf } from "../lib/validation";

type Carrier = {
  id: string;
  carrier_scope: string;
  code: string;
  name: string;
  scac: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  status: string;
  shipment_count: number;
  assignment_count: number;
  driver_count: number;
  vehicle_count: number;
  created_at: string;
  updated_at: string;
};
type CarrierDriver = {
  id: string;
  carrier_id: string;
  name: string;
  phone: string | null;
  license_number: string | null;
  status: string;
};
type CarrierVehicle = {
  id: string;
  carrier_id: string;
  plate_number: string;
  vehicle_type: string | null;
  capacity_weight_kg: number;
  capacity_volume_cbm: number;
  status: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "carrier.view");
  const [carriers, drivers, vehicles] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id,c.carrier_scope,c.code,c.name,c.scac,c.contact_name,c.contact_phone,c.contact_email,c.status,c.created_at,c.updated_at,
              (SELECT COUNT(*) FROM shipment_legs l WHERE l.carrier_id=c.id) shipment_count,
              (SELECT COUNT(*) FROM order_transport_assignments a WHERE a.carrier_id=c.id AND a.status!='cancelled') assignment_count,
              (SELECT COUNT(*) FROM carrier_drivers d WHERE d.carrier_id=c.id AND d.status='active') driver_count,
              (SELECT COUNT(*) FROM carrier_vehicles v WHERE v.carrier_id=c.id AND v.status='active') vehicle_count
         FROM carriers c
        WHERE c.organization_id=?
        ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END,c.name`,
    ).bind(current.organizationId).all<Carrier>(),
    env.DB.prepare(
      `SELECT id,carrier_id,name,phone,license_number,status FROM carrier_drivers WHERE organization_id=? AND status='active' ORDER BY name`,
    ).bind(current.organizationId).all<CarrierDriver>(),
    env.DB.prepare(
      `SELECT id,carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm,status FROM carrier_vehicles WHERE organization_id=? AND status='active' ORDER BY plate_number`,
    ).bind(current.organizationId).all<CarrierVehicle>(),
  ]);
  return {
    current,
    carriers: carriers.results,
    drivers: drivers.results,
    vehicles: vehicles.results,
    canManage: current.permissions.includes("carrier.manage"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "carrier.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  // --- 司机管理 ---
  if (intent === "driver_upsert") {
    const carrierId = valueOf(form, "carrierId");
    const driverId = valueOf(form, "driverId") || crypto.randomUUID();
    const name = valueOf(form, "driverName").trim();
    const phone = valueOf(form, "driverPhone").trim();
    const licenseNumber = valueOf(form, "licenseNumber").trim();
    if (name.length < 2) return { formError: "司机姓名至少 2 个字符" };
    const phoneError = phone ? validatePhone(phone, "司机电话") : undefined;
    if (phoneError) return { formError: phoneError };
    try {
      await env.DB.prepare(
        `INSERT INTO carrier_drivers(id,organization_id,carrier_id,name,phone,license_number,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?, 'active', ?,?)
         ON CONFLICT(organization_id,carrier_id,name) DO UPDATE SET phone=excluded.phone,license_number=excluded.license_number,status='active',updated_at=excluded.updated_at`,
      ).bind(driverId, current.organizationId, carrierId, name, phone || null, licenseNumber || null, now, now).run();
    } catch {
      return { formError: "司机保存失败，请检查承运商是否存在" };
    }
    return { success: `司机 ${name} 已保存` };
  }
  if (intent === "driver_toggle") {
    const driverId = valueOf(form, "driverId");
    const result=await env.DB.prepare(
      "UPDATE carrier_drivers SET status='disabled',updated_at=? WHERE id=? AND organization_id=? AND status='active'",
    ).bind(now, driverId, current.organizationId).run();
    if(!Number(result.meta?.changes||0))return{formError:"司机不存在或已被移除"};
    await writeAudit({request,action:"carrier.driver.disable",resourceType:"carrier_driver",resourceId:driverId,organizationId:current.organizationId,actorUserId:current.userId});
    return { success: "司机已移除" };
  }

  // --- 车辆管理 ---
  if (intent === "vehicle_upsert") {
    const carrierId = valueOf(form, "carrierId");
    const vehicleId = valueOf(form, "vehicleId") || crypto.randomUUID();
    const plateNumber = valueOf(form, "plateNumber").trim().toUpperCase();
    const vehicleType = valueOf(form, "vehicleType").trim();
    const capacityWeight = Number(valueOf(form, "capacityWeight")) || 0;
    const capacityVolume = Number(valueOf(form, "capacityVolume")) || 0;
    if (plateNumber.length < 2) return { formError: "车牌号至少 2 个字符" };
    try {
      await env.DB.prepare(
        `INSERT INTO carrier_vehicles(id,organization_id,carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?, 'active', ?,?)
         ON CONFLICT(organization_id,plate_number) DO UPDATE SET carrier_id=excluded.carrier_id,vehicle_type=excluded.vehicle_type,capacity_weight_kg=excluded.capacity_weight_kg,capacity_volume_cbm=excluded.capacity_volume_cbm,status='active',updated_at=excluded.updated_at`,
      ).bind(vehicleId, current.organizationId, carrierId, plateNumber, vehicleType || null, capacityWeight, capacityVolume, now, now).run();
    } catch {
      return { formError: "车辆保存失败，请检查承运商是否存在" };
    }
    return { success: `车辆 ${plateNumber} 已保存` };
  }
  if (intent === "vehicle_toggle") {
    const vehicleId = valueOf(form, "vehicleId");
    const result=await env.DB.prepare(
      "UPDATE carrier_vehicles SET status='disabled',updated_at=? WHERE id=? AND organization_id=? AND status='active'",
    ).bind(now, vehicleId, current.organizationId).run();
    if(!Number(result.meta?.changes||0))return{formError:"车辆不存在或已被移除"};
    await writeAudit({request,action:"carrier.vehicle.disable",resourceType:"carrier_vehicle",resourceId:vehicleId,organizationId:current.organizationId,actorUserId:current.userId});
    return { success: "车辆已移除" };
  }

  // --- 承运商启停 ---
  if (intent === "toggle") {
    const id = valueOf(form, "carrierId");
    const next = valueOf(form, "status");
    if (!['active','disabled'].includes(next)) return { formError: "承运商目标状态无效" };
    const row = await env.DB.prepare(
      "SELECT status FROM carriers WHERE id=? AND organization_id=?",
    ).bind(id, current.organizationId).first<{ status: string }>();
    if (!row) return { formError: "承运商不存在" };
    if (row.status === next) return { formError: next === "active" ? "承运商已启用" : "承运商已停用" };
    const result = await env.DB.prepare(
      "UPDATE carriers SET status=?,updated_at=? WHERE id=? AND organization_id=? AND status=?",
    ).bind(next, now, id, current.organizationId, row.status).run();
    if (!Number(result.meta?.changes || 0)) return { formError: "承运商状态已被其他人修改，请刷新后查看" };
    await writeAudit({
      request,
      action: `carrier.${next}`,
      resourceType: "carrier",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
    });
    return { success: "承运商状态已更新" };
  }

  // --- 承运商新增/修改 ---
  const id = valueOf(form, "carrierId") || crypto.randomUUID();
  const name = valueOf(form, "name");
  const scac = valueOf(form, "scac").toUpperCase();
  const contactName = valueOf(form, "contactName");
  const contactPhone = valueOf(form, "contactPhone");
  const status = valueOf(form, "status") || "active";
  const carrierScope = valueOf(form, "carrierScope") || "domestic";
  if (!name.trim() || !["active", "disabled"].includes(status) || !["domestic", "overseas"].includes(carrierScope)) {
    return { formError: "请填写承运商名称并选择有效类型和状态" };
  }
  const phoneError = contactPhone ? validatePhone(contactPhone, "承运商联系电话") : undefined;
  if (phoneError) return { formError: phoneError };
  const existing = await env.DB.prepare(
    "SELECT code,contact_email FROM carriers WHERE id=? AND organization_id=?",
  ).bind(id, current.organizationId).first<{ code: string; contact_email: string | null }>();
  const code = existing?.code || `carrier-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const contactEmail = existing?.contact_email || null;
  try {
    await env.DB.prepare(
      `INSERT INTO carriers(id,organization_id,code,name,scac,contact_name,contact_phone,contact_email,status,created_at,updated_at,carrier_scope)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,scac=excluded.scac,contact_name=excluded.contact_name,
         contact_phone=excluded.contact_phone,contact_email=excluded.contact_email,
         status=excluded.status,carrier_scope=excluded.carrier_scope,updated_at=excluded.updated_at`,
    ).bind(
      id, current.organizationId, code, name, scac || null,
      contactName || null, contactPhone || null, contactEmail,
      status, now, now, carrierScope,
    ).run();
  } catch {
    return { formError: "承运商保存失败，请稍后重试" };
  }
  await writeAudit({
    request,
    action: "carrier.upsert",
    resourceType: "carrier",
    resourceId: id,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: { code, name },
  });
  return { success: `承运商 ${name} 已保存` };
}

const VEHICLE_TYPE_OPTIONS = [
  "卡车", "13米平板", "13.5米高栏", "13.7米平板", "17.5米平板",
  "17.5米厢式车", "13米高栏", "16米厢式车", "13米厢式车", "冷藏车",
];

export default function Carriers({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">CARRIER MASTER</p>
          <h1>承运商管理</h1>
          <p>维护承运方主数据，展开每家承运商可管理其名下司机和车辆；后续配载与运输安排从主数据下拉选择。</p>
        </div>
        {loaderData.canManage && (
          <Modal title="新增承运商" triggerLabel="+ 新增承运商" closeSignal={actionData?.success}>
            <CarrierForm busy={busy} />
          </Modal>
        )}
      </header>
      {(actionData?.success || actionData?.formError) && (
        <div className={`alert ${actionData.formError ? "error" : "success"}`}>
          {actionData.formError ?? actionData.success}
        </div>
      )}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>承运商台账</h2>
            <p>点击承运商名称展开管理其司机与车辆；配载页选择车辆后自动带出车牌、司机和载重。</p>
          </div>
          <span className="status-pill">共 {loaderData.carriers.length} 家</span>
        </div>
        <div className="carrier-list">
          {loaderData.carriers.map((carrier) => {
            const drivers = loaderData.drivers.filter((d) => d.carrier_id === carrier.id);
            const vehicles = loaderData.vehicles.filter((v) => v.carrier_id === carrier.id);
            return (
              <details key={carrier.id} className="carrier-master-card">
                <summary className="carrier-master-summary">
                  <div className="carrier-master-info">
                    <strong>{carrier.name}</strong>
                    <span className="status-pill">{carrier.carrier_scope === "overseas" ? "境外承运商" : "境内承运商"}</span>
                    <small>{carrier.scac || carrier.contact_phone || "未填简称和电话"}</small>
                    <small>{carrier.contact_name || "无联系人"} · {carrier.contact_phone || "无电话"}</small>
                  </div>
                  <div className="carrier-master-counts">
                    <span className="status-pill">{carrier.driver_count} 名司机</span>
                    <span className="status-pill">{carrier.vehicle_count} 辆车</span>
                    <span className={`status-pill ${carrier.status !== "active" ? "off" : ""}`}>
                      {carrier.status === "active" ? "启用" : "停用"}
                    </span>
                  </div>
                </summary>
                <div className="carrier-master-body">
                  <div className="carrier-master-actions">
                    {loaderData.canManage && (
                      <>
                        <Modal title={`修改 ${carrier.name}`} triggerLabel="修改承运商" triggerClassName="text-button" closeSignal={actionData?.success}>
                          <CarrierForm carrier={carrier} busy={busy} />
                        </Modal>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="carrierId" value={carrier.id} />
                          <input type="hidden" name="status" value={carrier.status === "active" ? "disabled" : "active"} />
                          {carrier.status === "active"
                            ? <ConfirmAction title="停用承运商" description={`停用后 ${carrier.name} 及其车辆、司机将不能用于新的运输安排；历史运输记录不受影响。`} triggerLabel="停用" confirmLabel="确认停用" pending={busy}/>
                            : <button className="text-button" disabled={busy}>启用</button>}
                        </Form>
                      </>
                    )}
                  </div>

                  <div className="carrier-sub-section">
                    <h4>车辆台账</h4>
                    {vehicles.length > 0 && (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr><th>车牌号</th><th>车型</th><th>载重 KG</th><th>体积 CBM</th><th>操作</th></tr>
                          </thead>
                          <tbody>
                            {vehicles.map((v) => (
                              <tr key={v.id}>
                                <td><strong>{v.plate_number}</strong></td>
                                <td>{v.vehicle_type || "未指定"}</td>
                                <td>{v.capacity_weight_kg || "不限"}</td>
                                <td>{v.capacity_volume_cbm || "不限"}</td>
                                <td>{loaderData.canManage && (
                                  <Form method="post" style={{ display: "inline" }}>
                                    <input type="hidden" name="intent" value="vehicle_toggle" />
                                    <input type="hidden" name="vehicleId" value={v.id} />
                                    <ConfirmAction title="移除承运商车辆" description={`车辆 ${v.plate_number} 将从可选车辆台账中停用；已发生的运输记录不会删除。`} triggerLabel="移除" confirmLabel="确认移除" pending={busy}/>
                                  </Form>
                                )}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {loaderData.canManage && (
                      <Form method="post" className="form-grid compact carrier-sub-form">
                        <input type="hidden" name="intent" value="vehicle_upsert" />
                        <input type="hidden" name="carrierId" value={carrier.id} />
                        <label className="field"><span>车牌号</span><input name="plateNumber" required placeholder="例如 粤B12345" /></label>
                        <label className="field"><span>车型</span><select name="vehicleType" defaultValue=""><option value="">请选择</option>{VEHICLE_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
                        <label className="field"><span>载重 KG</span><input name="capacityWeight" type="number" defaultValue="0" /></label>
                        <label className="field"><span>体积 CBM</span><input name="capacityVolume" type="number" defaultValue="0" /></label>
                        <button className="secondary" disabled={busy}>添加车辆</button>
                      </Form>
                    )}
                    {vehicles.length === 0 && <p className="empty-state">暂无车辆，请先添加。</p>}
                  </div>

                  <div className="carrier-sub-section">
                    <h4>司机台账</h4>
                    {drivers.length > 0 && (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr><th>姓名</th><th>电话</th><th>驾照号</th><th>操作</th></tr>
                          </thead>
                          <tbody>
                            {drivers.map((d) => (
                              <tr key={d.id}>
                                <td><strong>{d.name}</strong></td>
                                <td>{d.phone || "未填写"}</td>
                                <td>{d.license_number || "未填写"}</td>
                                <td>{loaderData.canManage && (
                                  <Form method="post" style={{ display: "inline" }}>
                                    <input type="hidden" name="intent" value="driver_toggle" />
                                    <input type="hidden" name="driverId" value={d.id} />
                                    <ConfirmAction title="移除承运商司机" description={`司机 ${d.name} 将从可选司机台账中停用；已发生的运输记录不会删除。`} triggerLabel="移除" confirmLabel="确认移除" pending={busy}/>
                                  </Form>
                                )}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {loaderData.canManage && (
                      <Form method="post" className="form-grid compact carrier-sub-form">
                        <input type="hidden" name="intent" value="driver_upsert" />
                        <input type="hidden" name="carrierId" value={carrier.id} />
                        <label className="field"><span>司机姓名</span><input name="driverName" required placeholder="例如 张三" /></label>
                        <label className="field"><span>电话</span><input name="driverPhone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" maxLength={30} placeholder="选填" /></label>
                        <label className="field"><span>驾照号</span><input name="licenseNumber" placeholder="选填" /></label>
                        <button className="secondary" disabled={busy}>添加司机</button>
                      </Form>
                    )}
                    {drivers.length === 0 && <p className="empty-state">暂无司机，请先添加。</p>}
                  </div>
                </div>
              </details>
            );
          })}
          {!loaderData.carriers.length && (
            <p className="empty-state">暂无承运商，请先新增承运方，再展开管理其名下司机和车辆。</p>
          )}
        </div>
      </section>
    </>
  );
}

function CarrierForm({ carrier, busy }: { carrier?: Carrier; busy: boolean }) {
  return (
    <Form method="post" className="form-grid compact">
      <input type="hidden" name="intent" value="upsert" />
      {carrier && <input type="hidden" name="carrierId" value={carrier.id} />}
      <label className="field">
        <span>承运商名称</span>
        <input name="name" defaultValue={carrier?.name} required placeholder="例如 深圳某某车队" />
      </label>
      <label className="field">
        <span>承运商类型</span>
        <select name="carrierScope" defaultValue={carrier?.carrier_scope || "domestic"} required>
          <option value="domestic">境内承运商</option>
          <option value="overseas">境外承运商</option>
        </select>
      </label>
      <label className="field">
        <span>简称 / SCAC</span>
        <input name="scac" defaultValue={carrier?.scac || ""} placeholder="可选" />
      </label>
      <label className="field">
        <span>联系人</span>
        <input name="contactName" defaultValue={carrier?.contact_name || ""} />
      </label>
      <label className="field">
        <span>联系电话</span>
        <input name="contactPhone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" maxLength={30} defaultValue={carrier?.contact_phone || ""} />
      </label>
      <label className="field">
        <span>状态</span>
        <select name="status" defaultValue={carrier?.status || "active"}>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </label>
      <button className="primary" disabled={busy}>保存承运商</button>
    </Form>
  );
}

export function meta() {
  return [{ title: "承运商管理 | International TMS" }];
}
