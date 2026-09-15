import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.master-data";
import { requireSessionUser } from "../lib/auth.server";
import { validateCode, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { ActionToast } from "../components/ActionToast";

const categories = [
  ["country", "国家/地区"],
  ["province", "省/州"],
  ["city", "城市"],
  ["border_port", "出境口岸"],
  ["customs_place", "清关地"],
  ["transit_place", "中转地"],
  ["route", "汽运线路"],
  ["currency", "币种"],
  ["unit", "计量单位"],
  ["transport_mode", "运输方式"],
  ["service_level", "服务等级"],
  ["cargo_type", "货物类型"],
  ["lead_source", "线索来源"],
] as const;
const categoryIcons: Record<string, string> = {
  country: "◎",
  province: "⌖",
  city: "◉",
  border_port: "⇄",
  customs_place: "关",
  transit_place: "途",
  route: "线",
  currency: "＄",
  unit: "⌁",
  transport_mode: "➤",
  service_level: "☆",
  cargo_type: "◇",
  lead_source: "♧",
};
type Category = (typeof categories)[number][0];
type ReferenceRow = {
  id: string;
  category: string;
  code: string;
  name: string;
  name_en: string | null;
  parent_code: string | null;
  parent_name: string | null;
  sort_order: number;
  status: string;
};

function selectedCategory(request: Request): Category {
  const value = new URL(request.url).searchParams.get("category");
  return categories.some(([code]) => code === value)
    ? (value as Category)
    : "country";
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "master.view");
  const category = selectedCategory(request);
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "",
    pattern = `%${query}%`;
  const rows = await env.DB.prepare(
    "SELECT r.id,r.category,r.code,r.name,r.name_en,r.parent_code,p.name parent_name,r.sort_order,r.status FROM reference_data r LEFT JOIN reference_data p ON p.organization_id=r.organization_id AND p.code=r.parent_code AND p.category=CASE r.category WHEN 'province' THEN 'country' WHEN 'city' THEN 'province' END WHERE r.organization_id = ? AND r.category = ? AND (?='' OR r.code LIKE ? OR r.name LIKE ? OR COALESCE(r.name_en,'') LIKE ?) ORDER BY r.sort_order, r.code",
  )
    .bind(current.organizationId, category, query, pattern, pattern, pattern)
    .all<ReferenceRow>();
  const parentCategory =
    category === "province" ? "country" : category === "city" ? "province" : "";
  const parents = parentCategory
    ? await env.DB.prepare(
        "SELECT code,name,parent_code FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,code",
      )
        .bind(current.organizationId, parentCategory)
        .all<{ code: string; name: string; parent_code: string | null }>()
    : { results: [] };
  return {
    current,
    category,
    query,
    rows: rows.results,
    parents: parents.results,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "master.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  if (intent === "toggle") {
    const id = valueOf(form, "id");
    const row = await env.DB.prepare(
      "SELECT status FROM reference_data WHERE id = ? AND organization_id = ?",
    )
      .bind(id, current.organizationId)
      .first<{ status: string }>();
    if (!row) return { formError: "基础数据不存在" };
    const status = row.status === "active" ? "disabled" : "active";
    await env.DB.prepare(
      "UPDATE reference_data SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
    )
      .bind(status, new Date().toISOString(), id, current.organizationId)
      .run();
    await writeAudit({
      request,
      action: "master.toggle",
      resourceType: "reference_data",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { status },
    });
    return { success: "状态已更新" };
  }
  const category = valueOf(form, "category") as Category;
  const code = valueOf(form, "code").toUpperCase();
  const name = valueOf(form, "name");
  const nameEn = valueOf(form, "nameEn");
  const parentCode = valueOf(form, "parentCode");
  const sortOrder = Number(valueOf(form, "sortOrder") || 0);
  const errors: Record<string, string> = {};
  if (!categories.some(([item]) => item === category))
    errors.category = "分类无效";
  const requiredParentCategory =
    category === "province" ? "country" : category === "city" ? "province" : "";
  if (requiredParentCategory) {
    const parent = parentCode
      ? await env.DB.prepare(
          "SELECT 1 FROM reference_data WHERE organization_id=? AND category=? AND code=? AND status='active'",
        )
          .bind(current.organizationId, requiredParentCategory, parentCode)
          .first()
      : null;
    if (!parent)
      errors.parentCode =
        category === "province" ? "请选择所属国家/地区" : "请选择所属省/州";
  }
  const codeError = validateCode(code.toLowerCase());
  if (codeError) errors.code = codeError;
  if (name.length < 1 || name.length > 80) errors.name = "名称需要 1-80 个字符";
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999)
    errors.sortOrder = "排序需要是 0-9999 的整数";
  if (Object.keys(errors).length)
    return {
      errors,
      values: { category, code, name, nameEn, parentCode, sortOrder },
    };
  const now = new Date().toISOString(),
    id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO reference_data (id, organization_id, category, code, name, name_en, parent_code, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        current.organizationId,
        category,
        code,
        name,
        nameEn || null,
        parentCode || null,
        sortOrder,
        now,
        now,
      )
      .run();
  } catch {
    return {
      formError: "同一分类下代码不能重复",
      values: { category, code, name, nameEn, parentCode, sortOrder },
    };
  }
  await writeAudit({
    request,
    action: "master.create",
    resourceType: "reference_data",
    resourceId: id,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: { category, code },
  });
  return { success: "基础数据已创建" };
}

export function meta() {
  return [{ title: "基础数据 | International TMS" }];
}

export default function MasterData({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canManage = loaderData.current.permissions.includes("master.manage");
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">MASTER DATA</p>
          <h1>基础数据</h1>
          <p>维护运输、计费和销售流程共用的标准代码。</p>
        </div>
        <div className="page-actions">
          <span className="page-count">{loaderData.rows.length} 项</span>
          {canManage && (
            <Modal
              title="新增基础数据"
              triggerLabel="＋ 新增"
              closeSignal={actionData?.success}
            >
              <Form method="post" className="form-grid compact">
                <input type="hidden" name="intent" value="create" />
                <input
                  type="hidden"
                  name="category"
                  value={loaderData.category}
                />
                {loaderData.category === "province" && (
                  <label className="field span-2">
                    <span>所属国家/地区</span>
                    <select
                      name="parentCode"
                      required
                      defaultValue={actionData?.values?.parentCode}
                    >
                      <option value="">请选择国家/地区</option>
                      {loaderData.parents.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name}（{item.code}）
                        </option>
                      ))}
                    </select>
                    {actionData?.errors?.parentCode && (
                      <small className="field-error">
                        {actionData.errors.parentCode}
                      </small>
                    )}
                  </label>
                )}
                {loaderData.category === "city" && (
                  <label className="field span-2">
                    <span>所属省/州</span>
                    <select
                      name="parentCode"
                      required
                      defaultValue={actionData?.values?.parentCode}
                    >
                      <option value="">请选择省/州</option>
                      {loaderData.parents.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name}（{item.code}）
                        </option>
                      ))}
                    </select>
                    {actionData?.errors?.parentCode && (
                      <small className="field-error">
                        {actionData.errors.parentCode}
                      </small>
                    )}
                  </label>
                )}
                <label className="field">
                  <span>代码</span>
                  <input
                    name="code"
                    required
                    placeholder={
                      loaderData.category === "province"
                        ? "如 CN-GD"
                        : loaderData.category === "city"
                          ? "如 CN-GD-SZX"
                          : "CODE"
                    }
                    defaultValue={actionData?.values?.code}
                  />
                  {actionData?.errors?.code && (
                    <small className="field-error">
                      {actionData.errors.code}
                    </small>
                  )}
                </label>
                <label className="field">
                  <span>中文名称</span>
                  <input
                    name="name"
                    required
                    defaultValue={actionData?.values?.name}
                  />
                  {actionData?.errors?.name && (
                    <small className="field-error">
                      {actionData.errors.name}
                    </small>
                  )}
                </label>
                <label className="field">
                  <span>英文名称</span>
                  <input
                    name="nameEn"
                    defaultValue={actionData?.values?.nameEn}
                  />
                </label>
                <label className="field">
                  <span>排序</span>
                  <input
                    name="sortOrder"
                    type="number"
                    min="0"
                    max="9999"
                    defaultValue={actionData?.values?.sortOrder ?? 0}
                  />
                  {actionData?.errors?.sortOrder && (
                    <small className="field-error">
                      {actionData.errors.sortOrder}
                    </small>
                  )}
                </label>
                <button className="primary" disabled={busy}>
                  新增
                </button>
              </Form>
            </Modal>
          )}
        </div>
      </header>
      <nav className="tabs master-tabs peer-page-tabs">
        {categories.map(([code, label]) => (
          <Link
            key={code}
            className={loaderData.category === code ? "active" : ""}
            to={`?category=${code}`}
          >
            <span>{categoryIcons[code]}</span>
            {label}
          </Link>
        ))}
      </nav>
      <ActionToast data={actionData} />
      <Form method="get" action="." className="master-search">
        <input type="hidden" name="category" value={loaderData.category} />
        <span>⌕</span>
        <input
          name="q"
          defaultValue={loaderData.query}
          placeholder={`搜索${categories.find(([code]) => code === loaderData.category)?.[1] ?? "基础数据"}...`}
        />
        <button className="text-button">搜索</button>
      </Form>
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>代码</th>
                {["province", "city"].includes(loaderData.category) && (
                  <th>上级地区</th>
                )}
                <th>名称</th>
                <th>英文名称</th>
                <th>排序</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loaderData.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.code}</strong>
                  </td>
                  {["province", "city"].includes(loaderData.category) && (
                    <td>{row.parent_name || row.parent_code || "—"}</td>
                  )}
                  <td>{row.name}</td>
                  <td>{row.name_en || "—"}</td>
                  <td>{row.sort_order}</td>
                  <td>
                    <span
                      className={`status-pill ${row.status !== "active" ? "off" : ""}`}
                    >
                      {row.status === "active" ? "启用" : "停用"}
                    </span>
                  </td>
                  <td>
                    {loaderData.current.permissions.includes(
                      "master.manage",
                    ) && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggle" />
                        <input type="hidden" name="id" value={row.id} />
                        <button className="text-button">
                          {row.status === "active" ? "停用" : "启用"}
                        </button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
