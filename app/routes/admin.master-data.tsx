import { env } from "cloudflare:workers";
import { useMemo, useState } from "react";
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

type Category = (typeof categories)[number][0];
type GeographicCategory = "country" | "province" | "city";
type FlatCategory = Exclude<Category, GeographicCategory>;
type ViewCategory = "geography" | FlatCategory;

const geographicCategories = new Set<Category>(["country", "province", "city"]);
const viewCategories: ReadonlyArray<readonly [ViewCategory, string]> = [
  ["geography", "行政区划"],
  ...categories.filter(
    ([category]) => !geographicCategories.has(category),
  ) as ReadonlyArray<readonly [FlatCategory, string]>,
];
const categoryLabels = Object.fromEntries(categories) as Record<Category, string>;
const categoryIcons: Record<ViewCategory, string> = {
  geography: "◎",
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

type CreateTarget = {
  category: Category;
  parentCode?: string;
  parentName?: string;
};

function selectedCategory(request: Request): ViewCategory {
  const value = new URL(request.url).searchParams.get("category");
  if (!value || value === "geography" || geographicCategories.has(value as Category)) {
    return "geography";
  }
  return categories.some(([code]) => code === value)
    ? (value as FlatCategory)
    : "geography";
}

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "master.view");
  const category = selectedCategory(request);
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const pattern = `%${query}%`;
  const rows = category === "geography"
    ? await env.DB.prepare(
        "SELECT r.id,r.category,r.code,r.name,r.name_en,r.parent_code,p.name parent_name,r.sort_order,r.status FROM reference_data r LEFT JOIN reference_data p ON p.organization_id=r.organization_id AND p.code=r.parent_code AND p.category=CASE r.category WHEN 'province' THEN 'country' WHEN 'city' THEN 'province' END WHERE r.organization_id = ? AND r.category IN ('country','province','city') ORDER BY CASE r.category WHEN 'country' THEN 1 WHEN 'province' THEN 2 ELSE 3 END, r.sort_order, r.code",
      )
        .bind(current.organizationId)
        .all<ReferenceRow>()
    : await env.DB.prepare(
        "SELECT r.id,r.category,r.code,r.name,r.name_en,r.parent_code,p.name parent_name,r.sort_order,r.status FROM reference_data r LEFT JOIN reference_data p ON p.organization_id=r.organization_id AND p.code=r.parent_code AND p.category=CASE r.category WHEN 'province' THEN 'country' WHEN 'city' THEN 'province' END WHERE r.organization_id = ? AND r.category = ? AND (?='' OR r.code LIKE ? OR r.name LIKE ? OR COALESCE(r.name_en,'') LIKE ?) ORDER BY r.sort_order, r.code",
      )
        .bind(current.organizationId, category, query, pattern, pattern, pattern)
        .all<ReferenceRow>();
  return {
    current,
    category,
    query,
    rows: rows.results,
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
  if (!categories.some(([item]) => item === category)) {
    errors.category = "分类无效";
  }
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
    if (!parent) {
      errors.parentCode =
        category === "province" ? "请选择所属国家/地区" : "请选择所属省/州";
    }
  }
  const codeError = validateCode(code.toLowerCase());
  if (codeError) errors.code = codeError;
  if (name.length < 1 || name.length > 80) errors.name = "名称需要 1-80 个字符";
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
    errors.sortOrder = "排序需要是 0-9999 的整数";
  }
  if (Object.keys(errors).length) {
    return {
      errors,
      values: { category, code, name, nameEn, parentCode, sortOrder },
    };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
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
  return { success: "基础数据已创建", createdId: id };
}

export function meta() {
  return [{ title: "基础数据 | International TMS" }];
}

function GeographyTree({
  rows,
  query,
  canManage,
  busy,
  onCreate,
}: {
  rows: ReferenceRow[];
  query: string;
  canManage: boolean;
  busy: boolean;
  onCreate: (target: CreateTarget) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const countries = rows.filter((row) => row.category === "country");
    const provincesByCountry = new Map<string, ReferenceRow[]>();
    const citiesByProvince = new Map<string, ReferenceRow[]>();
    const countriesByCode = new Map(countries.map((row) => [row.code, row]));
    const provincesByCode = new Map<string, ReferenceRow>();
    rows.forEach((row) => {
      if (row.category === "province") {
        provincesByCode.set(row.code, row);
        const items = provincesByCountry.get(row.parent_code ?? "") ?? [];
        items.push(row);
        provincesByCountry.set(row.parent_code ?? "", items);
      } else if (row.category === "city") {
        const items = citiesByProvince.get(row.parent_code ?? "") ?? [];
        items.push(row);
        citiesByProvince.set(row.parent_code ?? "", items);
      }
    });

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleIds = new Set<string>();
    const includeProvince = (province: ReferenceRow, includeChildren = false) => {
      visibleIds.add(province.id);
      const country = countriesByCode.get(province.parent_code ?? "");
      if (country) visibleIds.add(country.id);
      if (includeChildren) {
        (citiesByProvince.get(province.code) ?? []).forEach((city) => visibleIds.add(city.id));
      }
    };
    if (normalizedQuery) {
      rows.forEach((row) => {
        const searchable = `${row.code} ${row.name} ${row.name_en ?? ""}`.toLocaleLowerCase();
        if (!searchable.includes(normalizedQuery)) return;
        visibleIds.add(row.id);
        if (row.category === "country") {
          (provincesByCountry.get(row.code) ?? []).forEach((province) => {
            includeProvince(province, true);
          });
        } else if (row.category === "province") {
          includeProvince(row, true);
        } else if (row.category === "city") {
          const province = provincesByCode.get(row.parent_code ?? "");
          if (province) includeProvince(province);
        }
      });
    } else {
      rows.forEach((row) => visibleIds.add(row.id));
    }
    return { countries, provincesByCountry, citiesByProvince, visibleIds };
  }, [query, rows]);

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderNode = (row: ReferenceRow, level: number) => {
    if (!tree.visibleIds.has(row.id)) return null;
    const children = row.category === "country"
      ? tree.provincesByCountry.get(row.code) ?? []
      : row.category === "province"
        ? tree.citiesByProvince.get(row.code) ?? []
        : [];
    const visibleChildren = children.filter((child) => tree.visibleIds.has(child.id));
    const key = `${row.category}:${row.code}`;
    const isExpanded = query ? visibleChildren.length > 0 : expanded.has(key);
    const childCategory = row.category === "country"
      ? "province"
      : row.category === "province"
        ? "city"
        : null;

    return (
      <li key={row.id} className="master-tree-item" role="treeitem" aria-expanded={visibleChildren.length ? isExpanded : undefined}>
        <div className={`master-tree-row level-${level} ${row.status !== "active" ? "is-disabled" : ""}`}>
          <div className="master-tree-identity">
            <span className="master-tree-kind">{categoryLabels[row.category as Category]}</span>
            <strong>{row.name}</strong>
            <code>{row.code}</code>
            {row.name_en && <small>{row.name_en}</small>}
          </div>
          <div className="master-tree-branch-control">
            {visibleChildren.length > 0 ? (
              <button
                type="button"
                className="master-tree-disclosure"
                aria-label={`${isExpanded ? "收起" : "展开"}${row.name}的${categoryLabels[childCategory!]}`}
                aria-expanded={isExpanded}
                onClick={() => toggleExpanded(key)}
              >
                <span aria-hidden="true">{isExpanded ? "⌄" : "›"}</span>
                {isExpanded ? "收起" : "展开"}{categoryLabels[childCategory!]}
                <strong>{children.length}</strong>
              </button>
            ) : (
              <span className="master-tree-empty-branch">
                {childCategory ? `暂无${categoryLabels[childCategory]}` : "末级节点"}
              </span>
            )}
          </div>
          <span className={`status-pill ${row.status !== "active" ? "off" : ""}`}>
            {row.status === "active" ? "启用" : "停用"}
          </span>
          <div className="master-tree-actions">
            {canManage && childCategory && row.status === "active" && (
              <button
                type="button"
                className="primary compact-button master-tree-add"
                onClick={() => onCreate({
                  category: childCategory,
                  parentCode: row.code,
                  parentName: row.name,
                })}
              >
                添加下级：{categoryLabels[childCategory]}
              </button>
            )}
            {canManage && (
              <Form method="post">
                <input type="hidden" name="intent" value="toggle" />
                <input type="hidden" name="id" value={row.id} />
                <button className="text-button" disabled={busy}>
                  {row.status === "active" ? "停用" : "启用"}
                </button>
              </Form>
            )}
          </div>
        </div>
        {isExpanded && visibleChildren.length > 0 && (
          <ul className="master-tree-children" role="group">
            {visibleChildren.map((child) => renderNode(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };

  const visibleCountries = tree.countries.filter((row) => tree.visibleIds.has(row.id));
  if (!visibleCountries.length) {
    return <div className="master-tree-empty">没有找到匹配的行政区划。</div>;
  }
  return (
    <ul className="master-tree" role="tree" aria-label="行政区划">
      {visibleCountries.map((country) => renderNode(country, 0))}
    </ul>
  );
}

export default function MasterData({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canManage = loaderData.current.permissions.includes("master.manage");
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const isGeography = loaderData.category === "geography";
  const geographicCounts = isGeography
    ? {
        country: loaderData.rows.filter((row) => row.category === "country").length,
        province: loaderData.rows.filter((row) => row.category === "province").length,
        city: loaderData.rows.filter((row) => row.category === "city").length,
      }
    : null;
  const submittedValues = createTarget && actionData?.values?.category === createTarget.category
    && (actionData.values.parentCode ?? "") === (createTarget.parentCode ?? "")
    ? actionData.values
    : undefined;
  const viewLabel = viewCategories.find(([code]) => code === loaderData.category)?.[1] ?? "基础数据";

  return (
    <div className="master-data-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">MASTER DATA</p>
          <h1>基础数据</h1>
          <p>维护运输、计费和销售流程共用的标准代码。</p>
        </div>
        <div className="page-actions">
          <span className="page-count">
            {geographicCounts
              ? `${geographicCounts.country} 国 · ${geographicCounts.province} 省/州 · ${geographicCounts.city} 市`
              : `${loaderData.rows.length} 项`}
          </span>
          {canManage && (
            <button
              type="button"
              className="primary"
              onClick={() => setCreateTarget({
                category: loaderData.category === "geography" ? "country" : loaderData.category,
              })}
            >
              {isGeography ? "＋ 新增国家/地区" : "＋ 新增"}
            </button>
          )}
        </div>
      </header>

      <nav className="tabs master-tabs peer-page-tabs" aria-label="基础数据分类">
        {viewCategories.map(([code, label]) => (
          <Link
            key={code}
            className={loaderData.category === code ? "active" : ""}
            aria-current={loaderData.category === code ? "page" : undefined}
            to={`?category=${code}`}
          >
            <span aria-hidden="true">{categoryIcons[code]}</span>
            {label}
          </Link>
        ))}
      </nav>

      <ActionToast data={actionData} />
      <Form method="get" action="." className="master-search">
        <input type="hidden" name="category" value={loaderData.category} />
        <span aria-hidden="true">⌕</span>
        <input
          name="q"
          defaultValue={loaderData.query}
          placeholder={isGeography ? "搜索国家、省/州或城市..." : `搜索${viewLabel}...`}
          aria-label={`搜索${viewLabel}`}
        />
        <button className="text-button">搜索</button>
      </Form>

      {isGeography ? (
        <section className="panel master-tree-panel">
          <header className="master-tree-heading">
            <div>
              <h2>行政区划树</h2>
              <p>“展开下级”用于查看层级；右侧橙色按钮用于添加新的下级节点。</p>
            </div>
            <div className="master-tree-legend" aria-label="层级说明">
              <span>国家/地区</span><i aria-hidden="true">→</i><span>省/州</span><i aria-hidden="true">→</i><span>城市</span>
            </div>
          </header>
          <GeographyTree
            rows={loaderData.rows}
            query={loaderData.query}
            canManage={canManage}
            busy={busy}
            onCreate={setCreateTarget}
          />
        </section>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>代码</th>
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
                    <td><strong>{row.code}</strong></td>
                    <td>{row.name}</td>
                    <td>{row.name_en || "—"}</td>
                    <td>{row.sort_order}</td>
                    <td>
                      <span className={`status-pill ${row.status !== "active" ? "off" : ""}`}>
                        {row.status === "active" ? "启用" : "停用"}
                      </span>
                    </td>
                    <td>
                      {canManage && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="id" value={row.id} />
                          <button className="text-button" disabled={busy}>
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
      )}

      <Modal
        title={createTarget
          ? `新增${categoryLabels[createTarget.category]}${createTarget.parentName ? ` · ${createTarget.parentName}` : ""}`
          : "新增基础数据"}
        isOpen={Boolean(createTarget)}
        onOpenChange={(open) => {
          if (!open) setCreateTarget(null);
        }}
        closeSignal={actionData?.createdId}
        dialogClassName="master-create-modal"
        guardFormChanges
      >
        {createTarget && (
          <Form method="post" className="form-grid compact master-create-form">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="category" value={createTarget.category} />
            <input type="hidden" name="parentCode" value={createTarget.parentCode ?? ""} />
            {createTarget.parentName && (
              <div className="master-create-parent span-2">
                <span>添加到</span>
                <strong>{createTarget.parentName}</strong>
                <code>{createTarget.parentCode}</code>
              </div>
            )}
            <label className="field">
              <span>代码 *</span>
              <input
                name="code"
                required
                placeholder={
                  createTarget.category === "country"
                    ? "如 CN"
                    : createTarget.category === "province"
                      ? "如 CN-GD"
                      : createTarget.category === "city"
                        ? "如 CN-GD-SZX"
                        : "CODE"
                }
                defaultValue={submittedValues?.code}
              />
              {actionData?.errors?.code && submittedValues && (
                <small className="field-error">{actionData.errors.code}</small>
              )}
            </label>
            <label className="field">
              <span>中文名称 *</span>
              <input name="name" required defaultValue={submittedValues?.name} />
              {actionData?.errors?.name && submittedValues && (
                <small className="field-error">{actionData.errors.name}</small>
              )}
            </label>
            <label className="field">
              <span>英文名称</span>
              <input name="nameEn" defaultValue={submittedValues?.nameEn} />
            </label>
            <label className="field">
              <span>排序</span>
              <input
                name="sortOrder"
                type="number"
                min="0"
                max="9999"
                defaultValue={submittedValues?.sortOrder ?? 0}
              />
              {actionData?.errors?.sortOrder && submittedValues && (
                <small className="field-error">{actionData.errors.sortOrder}</small>
              )}
            </label>
            {actionData?.formError && submittedValues && (
              <p className="form-error span-2">{actionData.formError}</p>
            )}
            <div className="master-create-actions span-2">
              <button className="primary" disabled={busy}>确认新增</button>
            </div>
          </Form>
        )}
      </Modal>
    </div>
  );
}
