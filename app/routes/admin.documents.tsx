import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.documents";
import { requireSessionUser } from "../lib/auth.server";
import { orderDocumentPlacement, orderDocumentTypeLabel } from "../lib/order-documents";
import { BatchNumberLink, OrderNumberLink, OrderNumberLinkList } from "../components/EntityNumberLink";
import { batchVisibilitySql, orderVisibilitySql } from "../lib/order-access.server";

type FileRow = {
  id: string;
  source_type: "order" | "batch";
  order_id: string | null;
  order_numbers: string;
  order_refs: string;
  batch_id: string | null;
  batch_number: string | null;
  document_category: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  review_status: string;
  created_at: string;
  reviewed_at: string | null;
  uploader_name: string | null;
  reviewer_name: string | null;
};

const pageSize = 50;

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.module.documents.manage");
  const orderVisibility = orderVisibilitySql(current, "o");
  const batchVisibility = batchVisibilitySql(current, "b");
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const category = url.searchParams.get("category") || "all";
  const scope = url.searchParams.get("scope") === "batch" ? "batch" : "order";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const rows = await env.DB.prepare(
    `WITH files AS (
       SELECT a.id,'order' source_type,a.order_id,o.order_number order_numbers,o.id||'|'||o.order_number order_refs,
              NULL batch_id,NULL batch_number,COALESCE(m.document_category,'other') document_category,
              a.file_name,a.content_type,a.size_bytes,COALESCE(m.review_status,'pending') review_status,
              a.created_at,m.reviewed_at,up.display_name uploader_name,rv.display_name reviewer_name
         FROM order_attachments a
         JOIN transport_orders o ON o.id=a.order_id AND o.organization_id=a.organization_id
         LEFT JOIN order_document_metadata m ON m.attachment_id=a.id
         LEFT JOIN users up ON up.id=a.uploaded_by_user_id
         LEFT JOIN users rv ON rv.id=m.reviewed_by_user_id
        WHERE a.organization_id=? AND ${orderVisibility.sql}
       UNION ALL
       SELECT d.id,'batch' source_type,NULL order_id,
              COALESCE((SELECT GROUP_CONCAT(o.order_number) FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id WHERE bo.batch_id=d.batch_id AND bo.status!='removed'),'') order_numbers,
              COALESCE((SELECT GROUP_CONCAT(o.id||'|'||o.order_number) FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id WHERE bo.batch_id=d.batch_id AND bo.status!='removed'),'') order_refs,
              d.batch_id,b.batch_number,d.document_category,d.file_name,d.content_type,d.size_bytes,d.review_status,
              d.created_at,d.reviewed_at,up.display_name uploader_name,rv.display_name reviewer_name
         FROM transport_batch_documents d
         JOIN transport_batches b ON b.id=d.batch_id AND b.organization_id=d.organization_id
         LEFT JOIN users up ON up.id=d.uploaded_by_user_id
         LEFT JOIN users rv ON rv.id=d.reviewed_by_user_id
        WHERE d.organization_id=? AND ${batchVisibility.sql}
     )
     SELECT * FROM files
      WHERE source_type=?
        AND (?='' OR order_numbers LIKE '%'||?||'%' OR COALESCE(batch_number,'') LIKE '%'||?||'%' OR file_name LIKE '%'||?||'%')
        AND (?='all' OR review_status=?)
        AND (?='all' OR document_category=?)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(
    current.organizationId,...orderVisibility.values,current.organizationId,...batchVisibility.values,
    scope,q,q,q,q,status,status,category,category,pageSize,(page - 1) * pageSize,
  ).all<FileRow>();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) total FROM (
       SELECT a.id,'order' source_type,o.order_number order_numbers,NULL batch_number,COALESCE(m.document_category,'other') document_category,COALESCE(m.review_status,'pending') review_status,a.file_name
         FROM order_attachments a JOIN transport_orders o ON o.id=a.order_id AND o.organization_id=a.organization_id LEFT JOIN order_document_metadata m ON m.attachment_id=a.id
        WHERE a.organization_id=? AND ${orderVisibility.sql}
       UNION ALL
       SELECT d.id,'batch' source_type,COALESCE((SELECT GROUP_CONCAT(o.order_number) FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id WHERE bo.batch_id=d.batch_id AND bo.status!='removed'),''),b.batch_number,d.document_category,d.review_status,d.file_name
         FROM transport_batch_documents d JOIN transport_batches b ON b.id=d.batch_id AND b.organization_id=d.organization_id WHERE d.organization_id=? AND ${batchVisibility.sql}
     ) files
     WHERE source_type=?
       AND (?='' OR order_numbers LIKE '%'||?||'%' OR COALESCE(batch_number,'') LIKE '%'||?||'%' OR file_name LIKE '%'||?||'%')
       AND (?='all' OR review_status=?) AND (?='all' OR document_category=?)`,
  ).bind(current.organizationId,...orderVisibility.values,current.organizationId,...batchVisibility.values,scope,q,q,q,q,status,status,category,category).first<{ total: number }>();
  const scopeCounts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM order_attachments a JOIN transport_orders o ON o.id=a.order_id AND o.organization_id=a.organization_id WHERE a.organization_id=? AND ${orderVisibility.sql}) order_total,
       (SELECT COUNT(*) FROM transport_batch_documents d JOIN transport_batches b ON b.id=d.batch_id AND b.organization_id=d.organization_id WHERE d.organization_id=? AND ${batchVisibility.sql}) batch_total`,
  ).bind(current.organizationId,...orderVisibility.values,current.organizationId,...batchVisibility.values).first<{ order_total: number; batch_total: number }>();
  const categories = await env.DB.prepare(
    `SELECT document_category FROM order_document_metadata WHERE organization_id=?
     UNION SELECT document_category FROM transport_batch_documents WHERE organization_id=?
     ORDER BY document_category`,
  ).bind(current.organizationId,current.organizationId).all<{ document_category: string }>();
  return {
    rows: rows.results,
    total: total?.total ?? 0,
    scopeCounts: { order: scopeCounts?.order_total ?? 0, batch: scopeCounts?.batch_total ?? 0 },
    categories: categories.results.map((item) => item.document_category),
    q,status,category,scope,page,
    pageCount: Math.max(1, Math.ceil((total?.total ?? 0) / pageSize)),
  };
}

export default function DocumentCenter({ loaderData }: Route.ComponentProps) {
  return <>
    <header className="page-header"><div><p className="eyebrow">DOCUMENT INDEX</p><h1>文件中心</h1><p>集中查看订单与配载单文件；上传、编辑、审核和门禁仍由文件所属业务节点负责。</p></div><span className="status-pill">{loaderData.scope === "order" ? "订单文件" : "配载单文件"} · {loaderData.total} 个</span></header>
    <section className="panel"><Form method="get" action="." className="filter-bar compact document-center-filters">
      <fieldset className="document-scope-filter">
        <legend>文件归属</legend>
        <div className="document-scope-switch" data-scope={loaderData.scope}>
          <input id="document-scope-order" type="radio" name="scope" value="order" checked={loaderData.scope === "order"} onChange={(event) => event.currentTarget.form?.requestSubmit()} />
          <label htmlFor="document-scope-order"><span>订单文件</span><small>{loaderData.scopeCounts.order}</small></label>
          <input id="document-scope-batch" type="radio" name="scope" value="batch" checked={loaderData.scope === "batch"} onChange={(event) => event.currentTarget.form?.requestSubmit()} />
          <label htmlFor="document-scope-batch"><span>配载单文件</span><small>{loaderData.scopeCounts.batch}</small></label>
        </div>
      </fieldset>
      <label className="field"><span>{loaderData.scope === "order" ? "订单号 / 文件名" : "配载单号 / 挂载订单号 / 文件名"}</span><input name="q" defaultValue={loaderData.q} placeholder="输入关键词" /></label>
      <label className="field"><span>审核状态</span><select name="status" defaultValue={loaderData.status}><option value="all">全部</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已退回</option><option value="archived">已归档</option></select></label>
      <label className="field"><span>文件类型</span><select name="category" defaultValue={loaderData.category}><option value="all">全部</option>{loaderData.categories.map((item) => <option key={item} value={item}>{orderDocumentTypeLabel(item)}</option>)}</select></label>
      <button className="secondary">筛选</button><Link className="text-button" to={`/admin/documents?scope=${loaderData.scope}`}>重置</Link>
    </Form></section>
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>{loaderData.scope === "order" ? "订单" : "配载单 / 挂载订单"}</th><th>文件类型</th><th>文件</th><th>来源节点</th><th>审核状态</th><th>上传</th><th>审核</th><th>操作</th></tr></thead><tbody>{loaderData.rows.map((item) => {
      const placement = orderDocumentPlacement(item.document_category);
      const sourceHref = item.source_type === "batch" && item.batch_id
        ? `/admin/loading/${item.batch_id}#batch-files`
        : item.order_id && placement
          ? `/admin/orders/${item.order_id}/modules/${placement.moduleCode}#module-source-documents`
          : item.order_id ? `/admin/orders/${item.order_id}` : "/admin/documents";
      const fileHref = `/admin/document-files/${item.source_type}/${item.id}`;
      return <tr key={`${item.source_type}-${item.id}`}>
        <td>{item.batch_id&&item.batch_number?<strong><BatchNumberLink id={item.batch_id} number={item.batch_number}/></strong>:item.order_id?<strong><OrderNumberLink id={item.order_id} number={item.order_numbers}/></strong>:null}<small className="entity-number-list">{item.batch_id?<OrderNumberLinkList orders={orderReferences(item.order_refs)}/>:"订单文件"}</small></td>
        <td>{orderDocumentTypeLabel(item.document_category)}</td>
        <td><strong>{item.file_name}</strong><small>{formatBytes(item.size_bytes)} · {item.content_type}</small></td>
        <td>{placement ? moduleLabel(placement.moduleCode) : item.source_type === "batch" ? "配载单" : "其他"}</td>
        <td><span className={`status-pill ${item.review_status === "approved" || item.review_status === "archived" ? "success" : item.review_status === "rejected" ? "danger" : "warning"}`}>{reviewLabel(item.review_status)}</span></td>
        <td>{item.uploader_name || "—"}<small>{new Date(item.created_at).toLocaleString("zh-CN")}</small></td>
        <td>{item.reviewer_name || "—"}<small>{item.reviewed_at ? new Date(item.reviewed_at).toLocaleString("zh-CN") : "尚未审核"}</small></td>
        <td><div className="page-actions"><a className="text-button" href={`${fileHref}?mode=view`} target="_blank" rel="noreferrer">查看</a><a className="text-button" href={fileHref}>下载</a><Link className="text-button" to={sourceHref}>打开来源节点</Link></div></td>
      </tr>;
    })}</tbody></table></div>{!loaderData.rows.length && <p className="empty-state">当前筛选条件下没有{loaderData.scope === "order" ? "订单" : "配载单"}文件记录。</p>}
      {loaderData.pageCount > 1 && <div className="pagination">{loaderData.page > 1 && <Link className="secondary" to={pageHref(loaderData, loaderData.page - 1)}>上一页</Link>}<span>第 {loaderData.page} / {loaderData.pageCount} 页</span>{loaderData.page < loaderData.pageCount && <Link className="secondary" to={pageHref(loaderData, loaderData.page + 1)}>下一页</Link>}</div>}
    </section>
  </>;
}

function pageHref(data: { q: string; status: string; category: string; scope: string }, page: number) { return `/admin/documents?${new URLSearchParams({ q: data.q, status: data.status, category: data.category, scope: data.scope, page: String(page) })}`; }
function orderReferences(value: string) { return (value || "").split(",").flatMap((reference) => { const separator = reference.indexOf("|"); return separator > 0 ? [{ id: reference.slice(0, separator), number: reference.slice(separator + 1) }] : []; }); }
function formatBytes(value: number) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; }
function reviewLabel(value: string) { return ({ pending: "待审核", approved: "已通过", rejected: "已退回", archived: "已归档" } as Record<string, string>)[value] || value; }
function moduleLabel(value: string) { return ({ consignment: "委托信息", transport: "国内运输", customs: "报关作业", tracking: "运输跟踪", overseas_warehouse: "境外仓与自提", costs: "费用结算" } as Record<string, string>)[value] || value; }
export function meta() { return [{ title: "文件中心 | International TMS" }]; }
