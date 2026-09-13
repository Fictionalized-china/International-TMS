import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.order-workbench";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { ActionToast } from "../components/ActionToast";
import { requireSessionUser } from "../lib/auth.server";
import { orderVisibilitySql, requireOrderAccess } from "../lib/order-access.server";
import { writeAudit } from "../lib/audit.server";
import { assignOrderModule } from "../lib/order-modules.server";
import {
  normalizeWorkbenchSelection,
  validateWorkbenchBatch,
  type WorkbenchBatchCandidate,
  type WorkbenchBatchCheck,
  type WorkbenchCode,
} from "../lib/workbench-batch";

const PAGE_SIZE = 10;
const workspaces = {
  tasks: {
    title: "我的任务",
    description: "跨订单集中处理模块负责人、当前节点、待办和逾期事项。",
  },
  customs: {
    title: "报关",
    description: "集中查看需要报关或清关订单的资料、申报、查验和放行状态。",
  },
  documents: {
    title: "文件",
    description: "集中查看订单文件数量、待审核文件和单证负责人。",
  },
  tracking: {
    title: "运踪",
    description: "集中查看运输节点、最新位置、更新时间和待更新记录。",
  },
  costs: {
    title: "费用",
    description: "集中查看应收、应付、毛利以及客服、业务和财务三方并行签核状态。",
  },
} as const;

const views = {
  all: "全部状态",
  pending: "有待办",
  overdue: "已逾期",
} as const;
const scopes = {
  team: "全部业务",
  mine: "我的岗位",
  unassigned: "未分配",
} as const;

type Workspace = keyof typeof workspaces;
type View = keyof typeof views;
type Scope = keyof typeof scopes;
type Row = {
  row_id: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  module_code: string;
  state: string;
  primary_text: string | null;
  secondary_text: string | null;
  owner_id: string | null;
  owner_name: string | null;
  pending_count: number;
  overdue_count: number;
  updated_at: string;
};
type SavedView = {
  id: string;
  name: string;
  query_text: string | null;
  status_view: View;
  ownership_scope: Scope;
};
type Profile = {
  title: string | null;
  department_name: string | null;
  role_names: string | null;
};
type BatchResultItem = WorkbenchBatchCheck & { success: boolean };
type ActionResponse = {
  formError?: string;
  success?: string;
  batchPreview?: { items: WorkbenchBatchCheck[] };
  batchResult?: { items: BatchResultItem[] };
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const workspace = params.workspace as Workspace;
  const config = workspaces[workspace];
  if (!config) throw new Response("工作台不存在", { status: 404 });

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const requestedView = url.searchParams.get("view") as View;
  const requestedScope = url.searchParams.get("scope") as Scope;
  const view: View = requestedView in views ? requestedView : "all";
  const scope: Scope = requestedScope in scopes ? requestedScope : "team";
  const requestedPage = Math.max(
    1,
    Number(url.searchParams.get("page")) || 1,
  );
  const { cte, bindings } = workspaceQuery(
    workspace,
    current.organizationId,
  );
  const visibility = orderVisibilitySql(current, "scope_order");
  const conditions: string[] = [
    `order_id IN (SELECT scope_order.id FROM transport_orders scope_order WHERE scope_order.organization_id=? AND ${visibility.sql})`,
  ];
  const filterBindings: unknown[] = [...bindings];
  filterBindings.push(current.organizationId, ...visibility.values);

  if (q) {
    conditions.push(
      "LOWER(order_number||' '||customer_name||' '||COALESCE(primary_text,'')||' '||COALESCE(owner_name,'')) LIKE ?",
    );
    filterBindings.push(`%${q.toLowerCase()}%`);
  }
  if (view === "pending") conditions.push("pending_count > 0");
  if (view === "overdue") conditions.push("overdue_count > 0");
  if (scope === "mine") {
    conditions.push("owner_id = ?");
    filterBindings.push(current.userId);
  }
  if (scope === "unassigned") conditions.push("owner_id IS NULL");

  const filter = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await env.DB.prepare(
    `${cte} SELECT COUNT(*) total FROM rows ${filter}`,
  )
    .bind(...filterBindings)
    .first<{ total: number }>();
  const total = count?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const [rows, savedViews, profile] = await Promise.all([
    env.DB.prepare(
      `${cte} SELECT * FROM rows ${filter} ORDER BY overdue_count DESC,pending_count DESC,updated_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(...filterBindings, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<Row>(),
    env.DB.prepare(
      "SELECT id,name,query_text,status_view,ownership_scope FROM workbench_saved_views WHERE organization_id=? AND user_id=? AND workspace=? ORDER BY updated_at DESC,name",
    )
      .bind(current.organizationId, current.userId, workspace)
      .all<SavedView>(),
    env.DB.prepare(
      `SELECT m.title,d.name department_name,p.name role_names
       FROM memberships m
       LEFT JOIN departments d ON d.id=m.department_id
       LEFT JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
       WHERE m.organization_id=? AND m.user_id=?
       GROUP BY m.id,d.name,p.name`,
    )
      .bind(current.organizationId, current.userId)
      .first<Profile>(),
  ]);

  return {
    workspace,
    config,
    rows: rows.results,
    savedViews: savedViews.results,
    profile: profile ?? null,
    q,
    view,
    scope,
    total,
    page,
    pages,
    canManage: current.permissions.includes("order.manage"),
  };
}

export async function action({ request, params }: Route.ActionArgs): Promise<ActionResponse> {
  const current = await requireSessionUser(request, "order.view");
  const workspace = params.workspace as Workspace;
  if (!workspaces[workspace]) return { formError: "工作台不存在" };
  const form = await request.formData();
  const intent = text(form, "intent");

  if (intent === "save_view") {
    const name = text(form, "name").slice(0, 30);
    if (!name) return { formError: "请填写筛选方案名称" };
    const view = validView(text(form, "view"));
    const scope = validScope(text(form, "scope"));
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workbench_saved_views(id,organization_id,user_id,workspace,name,query_text,status_view,ownership_scope,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,user_id,workspace,name)
       DO UPDATE SET query_text=excluded.query_text,status_view=excluded.status_view,ownership_scope=excluded.ownership_scope,updated_at=excluded.updated_at`,
    )
      .bind(
        crypto.randomUUID(),
        current.organizationId,
        current.userId,
        workspace,
        name,
        text(form, "q") || null,
        view,
        scope,
        now,
        now,
      )
      .run();
    return { success: `筛选方案“${name}”已保存` };
  }

  if (intent === "delete_view") {
    await env.DB.prepare(
      "DELETE FROM workbench_saved_views WHERE id=? AND organization_id=? AND user_id=? AND workspace=?",
    )
      .bind(
        text(form, "savedViewId"),
        current.organizationId,
        current.userId,
        workspace,
      )
      .run();
    return { success: "筛选方案已删除" };
  }

  if (!["batch_preview", "batch_confirm"].includes(intent))
    return { formError: "未知操作" };
  if (!current.permissions.includes("order.manage"))
    return { formError: "没有批量领取权限" };

  let selectedIds: string[];
  try {
    selectedIds = normalizeWorkbenchSelection(
      form.getAll("rowId").map(String),
    );
  } catch (error) {
    return { formError: error instanceof Error ? error.message : "选择无效" };
  }
  if (!selectedIds.length) return { formError: "请至少勾选一条记录" };

  const candidates = await loadBatchCandidates(
    current.organizationId,
    selectedIds,
  );
  for (const candidate of candidates) await requireOrderAccess(current, candidate.order_id);
  const checks = validateWorkbenchBatch(
    selectedIds,
    candidates,
    workspace as WorkbenchCode,
    current.userId,
  );
  if (intent === "batch_preview")
    return { batchPreview: { items: checks } };

  const items: BatchResultItem[] = [];
  for (const check of checks) {
    if (!check.eligible || !check.orderId || !check.moduleCode) {
      items.push({ ...check, success: false });
      continue;
    }
    try {
      await assignOrderModule({
        organizationId: current.organizationId,
        orderId: check.orderId,
        moduleCode: check.moduleCode,
        assigneeUserId: current.userId,
        actorUserId: current.userId,
        notes: "从综合业务工作台批量领取",
      });
      items.push({ ...check, success: true, reason: "领取成功" });
    } catch (error) {
      items.push({
        ...check,
        success: false,
        reason: error instanceof Error ? error.message : "领取失败",
      });
    }
  }
  await writeAudit({
    request,
    action: "workbench.batch.claim",
    resourceType: "order_module_instance",
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: {
      workspace,
      selected: selectedIds.length,
      succeeded: items.filter((item) => item.success).length,
      failed: items.filter((item) => !item.success).length,
      rowIds: selectedIds,
    },
  });
  return { batchResult: { items } };
}

async function loadBatchCandidates(organizationId: string, ids: string[]) {
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT mi.id row_id,mi.order_id,o.order_number,c.name customer_name,mi.module_code,mi.module_name,mi.enabled,mi.status module_status,o.status order_status,mi.assignee_user_id,u.display_name assignee_name
     FROM order_module_instances mi
     JOIN transport_orders o ON o.id=mi.order_id
     JOIN customers c ON c.id=o.customer_id
     LEFT JOIN users u ON u.id=mi.assignee_user_id
     WHERE mi.organization_id=? AND mi.id IN (${placeholders})`,
  )
    .bind(organizationId, ...ids)
    .all<WorkbenchBatchCandidate>();
  return rows.results;
}

function workspaceQuery(workspace: Workspace, organizationId: string) {
  if (workspace === "tasks") {
    return {
      bindings: [organizationId],
      cte: `WITH rows AS (
        SELECT mi.id row_id,o.id order_id,o.order_number,c.name customer_name,mi.module_code,mi.current_step_name state,
          mi.module_name primary_text,
          CAST((SELECT COUNT(*) FROM order_tasks t WHERE t.order_id=o.id AND t.module_code=mi.module_code AND t.status IN ('pending','in_progress')) AS TEXT)||' 个待办' secondary_text,
          u.id owner_id,u.display_name owner_name,
          (SELECT COUNT(*) FROM order_tasks t WHERE t.order_id=o.id AND t.module_code=mi.module_code AND t.status IN ('pending','in_progress')) pending_count,
          (SELECT COUNT(*) FROM order_tasks t WHERE t.order_id=o.id AND t.module_code=mi.module_code AND t.status IN ('pending','in_progress') AND t.due_at IS NOT NULL AND t.due_at<datetime('now')) overdue_count,
          mi.updated_at
        FROM order_module_instances mi
        JOIN transport_orders o ON o.id=mi.order_id
        JOIN customers c ON c.id=o.customer_id
        LEFT JOIN users u ON u.id=mi.assignee_user_id
        WHERE mi.organization_id=? AND mi.enabled=1 AND mi.module_code!='assignment' AND o.status NOT IN ('completed','cancelled')
      )`,
    };
  }
  if (workspace === "customs")
    return moduleWorkspaceQuery(organizationId, "customs", `
      COALESCE((SELECT CASE r.clearance_stage WHEN 'origin' THEN '起运地' ELSE '目的地' END||' · '||r.status FROM order_customs_records r WHERE r.order_id=o.id ORDER BY r.updated_at DESC LIMIT 1),'尚未建立报关记录'),
      COALESCE((SELECT COALESCE(r.declaration_number,r.broker_name,'资料待补全') FROM order_customs_records r WHERE r.order_id=o.id ORDER BY r.updated_at DESC LIMIT 1),'资料待补全'),
      CASE WHEN EXISTS(SELECT 1 FROM order_customs_records r WHERE r.order_id=o.id) THEN 0 ELSE 1 END`);
  if (workspace === "documents")
    return moduleWorkspaceQuery(organizationId, "documents", `
      CAST((SELECT COUNT(*) FROM order_attachments a WHERE a.order_id=o.id) AS TEXT)||' 份文件',
      CAST((SELECT COUNT(*) FROM order_document_metadata dm WHERE dm.order_id=o.id AND dm.review_status='pending') AS TEXT)||' 份待审核',
      (SELECT COUNT(*) FROM order_document_metadata dm WHERE dm.order_id=o.id AND dm.review_status='pending')`);
  if (workspace === "tracking")
    return moduleWorkspaceQuery(organizationId, "tracking", `
      COALESCE((SELECT tm.milestone_name||CASE WHEN tm.location IS NOT NULL AND tm.location!='' THEN ' · '||tm.location ELSE '' END FROM order_tracking_milestones tm WHERE tm.order_id=o.id ORDER BY tm.event_at DESC,tm.created_at DESC LIMIT 1),'等待首个运输节点'),
      COALESCE((SELECT tm.event_at FROM order_tracking_milestones tm WHERE tm.order_id=o.id ORDER BY tm.event_at DESC,tm.created_at DESC LIMIT 1),'尚未更新'),
      CASE WHEN EXISTS(SELECT 1 FROM order_tracking_milestones tm WHERE tm.order_id=o.id) THEN 0 ELSE 1 END`);
  return {
    bindings: [organizationId],
    cte: `WITH rows AS (
      SELECT mi.id row_id,o.id order_id,o.order_number,c.name customer_name,'costs' module_code,mi.current_step_name state,
        '应收 '||printf('%.2f',COALESCE((SELECT SUM(e.amount) FROM business_expenses e WHERE e.order_id=o.id AND e.direction='receivable' AND e.stage!='cancelled'),0))||' / 应付 '||printf('%.2f',COALESCE((SELECT SUM(e.amount) FROM business_expenses e WHERE e.order_id=o.id AND e.direction='payable' AND e.stage!='cancelled'),0)) primary_text,
        CAST(COALESCE((SELECT SUM(dc.confirmed+dc.business_reviewed+dc.finance_reviewed) FROM order_expense_direction_controls dc WHERE dc.organization_id=o.organization_id AND dc.order_id=o.id),0) AS TEXT)||'/6 项并行签核完成' secondary_text,
        u.id owner_id,u.display_name owner_name,
        CASE WHEN EXISTS(SELECT 1 FROM business_expenses e WHERE e.order_id=o.id) THEN 0 ELSE 1 END pending_count,
        0 overdue_count,mi.updated_at
      FROM order_module_instances mi
      JOIN transport_orders o ON o.id=mi.order_id
      JOIN customers c ON c.id=o.customer_id
      LEFT JOIN users u ON u.id=mi.assignee_user_id
      WHERE mi.organization_id=? AND mi.module_code='costs' AND mi.enabled=1 AND o.status NOT IN ('completed','cancelled')
    )`,
  };
}

function moduleWorkspaceQuery(
  organizationId: string,
  moduleCode: string,
  expressions: string,
) {
  const [primaryText, secondaryText, pendingCount] = expressions
    .trim()
    .split(/,\s*\n/);
  return {
    bindings: [organizationId],
    cte: `WITH rows AS (
      SELECT mi.id row_id,o.id order_id,o.order_number,c.name customer_name,'${moduleCode}' module_code,mi.current_step_name state,
        ${primaryText} primary_text,
        ${secondaryText} secondary_text,
        u.id owner_id,u.display_name owner_name,
        ${pendingCount} pending_count,
        0 overdue_count,mi.updated_at
      FROM order_module_instances mi
      JOIN transport_orders o ON o.id=mi.order_id
      JOIN customers c ON c.id=o.customer_id
      LEFT JOIN users u ON u.id=mi.assignee_user_id
      WHERE mi.organization_id=? AND mi.module_code='${moduleCode}' AND mi.enabled=1 AND o.status NOT IN ('completed','cancelled')
    )`,
  };
}

export default function OrderWorkbench({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const response = actionData as ActionResponse | undefined;
  const [selected, setSelected] = useState<string[]>([]);
  const currentRows = loaderData.rows.map((row) => row.row_id);
  const allSelected =
    currentRows.length > 0 && currentRows.every((id) => selected.includes(id));
  const togglePage = (checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...new Set([...current, ...currentRows])]
        : current.filter((id) => !currentRows.includes(id)),
    );
  const toggleRow = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...new Set([...current, id])] : current.filter((item) => item !== id),
    );
  const filterHref = (nextScope: Scope) =>
    `?${new URLSearchParams({
      ...(loaderData.q ? { q: loaderData.q } : {}),
      ...(loaderData.view !== "all" ? { view: loaderData.view } : {}),
      ...(nextScope !== "team" ? { scope: nextScope } : {}),
    })}`;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">UNIFIED BUSINESS WORKBENCH</p>
          <h1>业务工作台</h1>
          <p>{loaderData.config.description}</p>
        </div>
        <div className="workbench-profile">
          <strong>{loaderData.profile?.title || "当前岗位"}</strong>
          <span>
            {loaderData.profile?.department_name || "未分配部门"} · {loaderData.profile?.role_names?.replaceAll(",", "、") || "普通成员"}
          </span>
          <small>{loaderData.total} 条记录</small>
        </div>
      </header>

      <nav className="tabs module-workbench-tabs peer-page-tabs" aria-label="业务工作台分类">
        {Object.entries(workspaces).map(([key, item]) => (
          <Link
            key={key}
            className={loaderData.workspace === key ? "active" : ""}
            to={`/admin/workbenches/${key}`}
          >
            {item.title}
          </Link>
        ))}
      </nav>

      <section className="workbench-view-bar" aria-label="岗位视图">
        <div>
          <strong>岗位视图</strong>
          {Object.entries(scopes).map(([key, label]) => (
            <Link
              key={key}
              className={loaderData.scope === key ? "active" : ""}
              to={filterHref(key as Scope)}
            >
              {label}
            </Link>
          ))}
        </div>
        <SavedViews
          workspace={loaderData.workspace}
          savedViews={loaderData.savedViews}
          q={loaderData.q}
          view={loaderData.view}
          scope={loaderData.scope}
        />
      </section>

      <ActionToast data={response}/>
      {response?.batchPreview && (
        <BatchReview items={response.batchPreview.items} />
      )}
      {response?.batchResult && (
        <BatchResult items={response.batchResult.items} />
      )}

      <section className="panel">
        <div className="panel-header workbench-filter-header">
          <Form method="get" action="." className="workbench-filter">
            <input type="hidden" name="scope" value={loaderData.scope} />
            <label>
              <span>关键词</span>
              <input
                name="q"
                defaultValue={loaderData.q}
                placeholder="订单、客户、负责人或业务摘要"
              />
            </label>
            <label>
              <span>状态视图</span>
              <select name="view" defaultValue={loaderData.view}>
                {Object.entries(views).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">查询</button>
            <Link className="secondary" to={`/admin/workbenches/${loaderData.workspace}`}>
              重置
            </Link>
          </Form>
        </div>

        <Form method="post" className="workbench-batch-form">
          <input type="hidden" name="intent" value="batch_preview" />
          {selected.map((id) => (
            <input key={id} type="hidden" name="rowId" value={id} />
          ))}
          <div className="workbench-batch-toolbar">
            <span>已选择 <strong>{selected.length}</strong> 条</span>
            <small>每次最多 50 条；执行前逐条校验，确认时再次校验。</small>
            <button
              type="submit"
              className="secondary"
              disabled={!selected.length || !loaderData.canManage}
            >
              批量领取预检
            </button>
          </div>
        </Form>

        <div className="table-wrap">
          <table className="workbench-table">
            <thead>
              <tr>
                <th className="selection-column">
                  <input
                    type="checkbox"
                    aria-label="选择当前页"
                    checked={allSelected}
                    onChange={(event) => togglePage(event.currentTarget.checked)}
                  />
                </th>
                <th>订单</th>
                <th>客户</th>
                <th>模块 / 状态</th>
                <th>业务摘要</th>
                <th>补充信息</th>
                <th>负责人</th>
                <th>待办</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.rows.map((row) => (
                <tr key={row.row_id} className={selected.includes(row.row_id) ? "selected-row" : ""}>
                  <td className="selection-column">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${row.order_number} ${row.module_code}`}
                      checked={selected.includes(row.row_id)}
                      onChange={(event) => toggleRow(row.row_id, event.currentTarget.checked)}
                    />
                  </td>
                  <td>
                    <Link to={`/admin/orders/${row.order_id}`}>
                      <strong>{row.order_number}</strong>
                    </Link>
                  </td>
                  <td>{row.customer_name}</td>
                  <td>
                    <span className="status-pill">{row.state || "未开始"}</span>
                    <small>{row.module_code}</small>
                  </td>
                  <td><strong>{row.primary_text || "—"}</strong></td>
                  <td>{row.secondary_text || "—"}</td>
                  <td>{row.owner_name || "未分配"}</td>
                  <td>
                    {row.pending_count}
                    {row.overdue_count > 0 && <small className="danger-text">逾期 {row.overdue_count}</small>}
                  </td>
                  <td>{new Date(row.updated_at).toLocaleString("zh-CN")}</td>
                  <td>
                    <Link className="text-button" to={`/admin/orders/${row.order_id}/modules/${row.module_code}`}>
                      进入处理
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loaderData.rows.length && <p className="empty-state">当前没有符合条件的记录。</p>}
        <Pagination
          page={loaderData.page}
          pages={loaderData.pages}
          q={loaderData.q}
          view={loaderData.view}
          scope={loaderData.scope}
        />
      </section>
    </>
  );
}

function SavedViews({
  workspace,
  savedViews,
  q,
  view,
  scope,
}: {
  workspace: Workspace;
  savedViews: SavedView[];
  q: string;
  view: View;
  scope: Scope;
}) {
  return (
    <div className="saved-view-area">
      <div className="saved-view-list">
        {savedViews.map((saved) => {
          const href = `?${new URLSearchParams({
            ...(saved.query_text ? { q: saved.query_text } : {}),
            ...(saved.status_view !== "all" ? { view: saved.status_view } : {}),
            ...(saved.ownership_scope !== "team" ? { scope: saved.ownership_scope } : {}),
          })}`;
          return (
            <span key={saved.id}>
              <Link to={href}>{saved.name}</Link>
              <Form method="post">
                <input type="hidden" name="intent" value="delete_view" />
                <input type="hidden" name="savedViewId" value={saved.id} />
                <button type="submit" aria-label={`删除筛选方案 ${saved.name}`}>×</button>
              </Form>
            </span>
          );
        })}
      </div>
      <Form method="post" className="saved-view-form">
        <input type="hidden" name="intent" value="save_view" />
        <input type="hidden" name="q" value={q} />
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="scope" value={scope} />
        <input name="name" maxLength={30} placeholder="方案名称" aria-label="筛选方案名称" />
        <button type="submit" className="secondary">保存当前筛选</button>
      </Form>
      {!savedViews.length && <small>尚未保存个人筛选方案</small>}
    </div>
  );
}

function BatchReview({ items }: { items: WorkbenchBatchCheck[] }) {
  const eligible = items.filter((item) => item.eligible);
  return (
    <section className="panel batch-review-panel" aria-live="polite">
      <div className="panel-header">
        <div>
          <p className="eyebrow">BATCH PRE-CHECK</p>
          <h2>批量领取预检结果</h2>
          <p>{eligible.length} 条可执行，{items.length - eligible.length} 条不可执行。确认时系统会再次逐条校验。</p>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="batch_confirm" />
          {eligible.map((item) => <input key={item.rowId} type="hidden" name="rowId" value={item.rowId} />)}
          <button type="submit" className="primary" disabled={!eligible.length}>确认领取 {eligible.length} 条</button>
        </Form>
      </div>
      <BatchItems items={items.map((item) => ({ ...item, success: item.eligible }))} preview />
    </section>
  );
}

function BatchResult({ items }: { items: BatchResultItem[] }) {
  const successes = items.filter((item) => item.success).length;
  return (
    <section className="panel batch-review-panel" aria-live="polite">
      <div className="panel-header">
        <div>
          <p className="eyebrow">BATCH RESULT</p>
          <h2>批量领取执行结果</h2>
          <p>{successes} 条成功，{items.length - successes} 条失败；失败记录未被修改。</p>
        </div>
      </div>
      <BatchItems items={items} />
    </section>
  );
}

function BatchItems({ items, preview = false }: { items: BatchResultItem[]; preview?: boolean }) {
  return (
    <div className="batch-result-list">
      {items.map((item) => (
        <div key={item.rowId} className={item.success ? "pass" : "fail"}>
          <span>{item.success ? "✓" : "!"}</span>
          <strong>{item.orderId?<OrderNumberLink id={item.orderId} number={item.orderNumber}/>:item.orderNumber}</strong>
          <small>{item.customerName} · {item.moduleName}</small>
          <b>{preview && item.success ? "可执行" : item.reason}</b>
        </div>
      ))}
    </div>
  );
}

function Pagination({
  page,
  pages,
  q,
  view,
  scope,
}: {
  page: number;
  pages: number;
  q: string;
  view: View;
  scope: Scope;
}) {
  if (pages <= 1) return null;
  const href = (next: number) =>
    `?${new URLSearchParams({
      ...(q ? { q } : {}),
      ...(view !== "all" ? { view } : {}),
      ...(scope !== "team" ? { scope } : {}),
      page: String(next),
    })}`;
  return (
    <footer className="pagination">
      <span>第 {page} / {pages} 页</span>
      <div>
        {page > 1 && <Link className="secondary" to={href(page - 1)}>上一页</Link>}
        {page < pages && <Link className="secondary" to={href(page + 1)}>下一页</Link>}
      </div>
    </footer>
  );
}

function validView(value: string): View {
  return value in views ? (value as View) : "all";
}
function validScope(value: string): Scope {
  return value in scopes ? (value as Scope) : "team";
}
function text(form: FormData, key: string) {
  return String(form.get(key) || "").trim();
}

export function meta({ params }: Route.MetaArgs) {
  const config = workspaces[params.workspace as Workspace];
  return [{ title: `${config?.title ?? "业务工作台"} | International TMS` }];
}
