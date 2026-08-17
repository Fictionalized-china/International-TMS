import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.carriers";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { validateCode, validateEmail, valueOf } from "../lib/validation";

type Carrier = {
  id: string;
  code: string;
  name: string;
  scac: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  status: string;
  shipment_count: number;
  assignment_count: number;
  created_at: string;
  updated_at: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "carrier.view");
  const carriers = await env.DB.prepare(
    `SELECT c.id,c.code,c.name,c.scac,c.contact_name,c.contact_phone,c.contact_email,c.status,c.created_at,c.updated_at,
            (SELECT COUNT(*) FROM shipment_legs l WHERE l.carrier_id=c.id) shipment_count,
            (SELECT COUNT(*) FROM order_transport_assignments a WHERE a.carrier_id=c.id AND a.status!='cancelled') assignment_count
       FROM carriers c
      WHERE c.organization_id=?
      ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END,c.name`,
  ).bind(current.organizationId).all<Carrier>();
  return {
    current,
    carriers: carriers.results,
    canManage: current.permissions.includes("carrier.manage"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "carrier.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (intent === "toggle") {
    const id = valueOf(form, "carrierId");
    const row = await env.DB.prepare(
      "SELECT status FROM carriers WHERE id=? AND organization_id=?",
    ).bind(id, current.organizationId).first<{ status: string }>();
    if (!row) return { formError: "承运商不存在" };
    const next = row.status === "active" ? "disabled" : "active";
    await env.DB.prepare(
      "UPDATE carriers SET status=?,updated_at=? WHERE id=? AND organization_id=?",
    ).bind(next, now, id, current.organizationId).run();
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

  const id = valueOf(form, "carrierId") || crypto.randomUUID();
  const code = valueOf(form, "code").toLowerCase();
  const name = valueOf(form, "name");
  const scac = valueOf(form, "scac").toUpperCase();
  const contactName = valueOf(form, "contactName");
  const contactPhone = valueOf(form, "contactPhone");
  const contactEmail = valueOf(form, "contactEmail").toLowerCase();
  const status = valueOf(form, "status") || "active";
  const codeError = validateCode(code);
  const emailError = contactEmail ? validateEmail(contactEmail) : null;
  if (codeError || name.length < 2 || !["active", "disabled"].includes(status) || emailError) {
    return { formError: codeError || emailError || "请填写有效的承运商代码、名称和状态" };
  }
  try {
    await env.DB.prepare(
      `INSERT INTO carriers(id,organization_id,code,name,scac,contact_name,contact_phone,contact_email,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,code) DO UPDATE SET
         name=excluded.name,scac=excluded.scac,contact_name=excluded.contact_name,
         contact_phone=excluded.contact_phone,contact_email=excluded.contact_email,
         status=excluded.status,updated_at=excluded.updated_at`,
    ).bind(
      id,
      current.organizationId,
      code,
      name,
      scac || null,
      contactName || null,
      contactPhone || null,
      contactEmail || null,
      status,
      now,
      now,
    ).run();
  } catch {
    return { formError: "承运商代码不能重复" };
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

export default function Carriers({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">CARRIER MASTER</p>
          <h1>承运商管理</h1>
          <p>维护国内承运方、车队联系人和电话；运输安排选择承运商后会自动带出联系方式。</p>
        </div>
        {loaderData.canManage && (
          <Modal
            title="新增承运商"
            triggerLabel="+ 新增承运商"
            closeSignal={actionData?.success}
          >
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
            <p>承运商是主数据；订单和配载里的“承运商名称”只是显示字段或手工兜底。</p>
          </div>
          <span className="status-pill">共 {loaderData.carriers.length} 家</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>承运商</th>
                <th>联系人</th>
                <th>电话</th>
                <th>邮箱</th>
                <th>使用情况</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.carriers.map((carrier) => (
                <tr key={carrier.id}>
                  <td>
                    <strong>{carrier.name}</strong>
                    <small>{carrier.code}{carrier.scac ? ` · ${carrier.scac}` : ""}</small>
                  </td>
                  <td>{carrier.contact_name || "未填写"}</td>
                  <td>{carrier.contact_phone || "未填写"}</td>
                  <td>{carrier.contact_email || "未填写"}</td>
                  <td>
                    <small>运输安排 {carrier.assignment_count} 次 · 运单分段 {carrier.shipment_count} 次</small>
                  </td>
                  <td>
                    <span className={`status-pill ${carrier.status !== "active" ? "off" : ""}`}>
                      {carrier.status === "active" ? "启用" : "停用"}
                    </span>
                  </td>
                  <td>
                    {loaderData.canManage ? (
                      <div className="table-actions">
                        <Modal
                          title={`修改 ${carrier.name}`}
                          triggerLabel="修改"
                          triggerClassName="text-button"
                          closeSignal={actionData?.success}
                        >
                          <CarrierForm carrier={carrier} busy={busy} />
                        </Modal>
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="carrierId" value={carrier.id} />
                          <button className="text-button" disabled={busy}>
                            {carrier.status === "active" ? "停用" : "启用"}
                          </button>
                        </Form>
                      </div>
                    ) : (
                      "只读"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loaderData.carriers.length && (
          <p className="empty-state">暂无承运商，请先新增国内承运方，后续运输安排和配载会从这里下拉选择。</p>
        )}
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
        <span>承运商代码</span>
        <input name="code" defaultValue={carrier?.code} required placeholder="例如 e2e-carrier" />
      </label>
      <label className="field">
        <span>承运商名称</span>
        <input name="name" defaultValue={carrier?.name} required placeholder="例如 深圳某某车队" />
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
        <input name="contactPhone" defaultValue={carrier?.contact_phone || ""} />
      </label>
      <label className="field">
        <span>邮箱</span>
        <input name="contactEmail" type="email" defaultValue={carrier?.contact_email || ""} />
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
