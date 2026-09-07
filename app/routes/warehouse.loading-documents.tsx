import { env } from "cloudflare:workers";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/warehouse.loading-documents";
import { Modal } from "../components/Modal";
import { QueryPagination } from "../components/QueryPagination";
import { ActionToast } from "../components/ActionToast";
import { requireSessionUser } from "../lib/auth.server";
import {
  currentStageLoadingDocumentRequirements,
  loadingOrderDocumentDefinitions,
  summarizeLoadingDocumentRequirements,
  warehouseLoadingDocumentMutationPolicy,
  type LoadingOrderDocumentCode,
  type OrderLoadingDocumentRequirements,
} from "../lib/loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "../lib/loading-document-requirements.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { paginateList, readListPage } from "../lib/list-pagination";

const LOADING_DOCUMENTS = loadingOrderDocumentDefinitions;
const PAGE_SIZE = 10;
type LoadingDocumentCode = LoadingOrderDocumentCode;
type BatchRow = {
  id: string;
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  status: string;
  road_status: string;
  updated_at: string;
  order_count: number;
  order_ids: string;
  order_numbers: string;
  uploaded_count: number;
  approved_count: number;
  rejected_count: number;
  dispatch_id: string | null;
};
type OrderRow = {
  order_id: string;
  order_number: string;
  customer_name: string;
  cargo_names: string | null;
  sequence_no: number;
};
type DocumentRow = {
  order_id: string;
  attachment_id: string;
  document_category: LoadingDocumentCode;
  file_name: string;
  content_type: string;
  review_status: string;
  created_at: string;
};
type BatchDocumentStatusRow = {
  batch_id: string;
  order_id: string;
  document_category: LoadingDocumentCode;
  review_status: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  if (warehouse.warehouse_role === "overseas_destination") {
    throw new Response("境外目的仓不办理配载文件", { status: 403 });
  }
  const url = new URL(request.url);
  const requestedBatchId = url.searchParams.get("batchId")?.trim() || "";
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const documentCodes = LOADING_DOCUMENTS.map((item) => `'${item.code}'`).join(",");
  const batchSummarySql = `WITH ranked_documents AS (
       SELECT bo.batch_id,m.order_id,m.document_category,m.review_status,
         ROW_NUMBER() OVER(PARTITION BY bo.batch_id,m.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
       FROM transport_batch_orders bo
       JOIN order_document_metadata m ON m.order_id=bo.order_id AND m.organization_id=bo.organization_id
       JOIN order_attachments a ON a.id=m.attachment_id AND a.organization_id=m.organization_id
       WHERE bo.organization_id=? AND bo.status!='removed' AND m.document_category IN (${documentCodes})
     )
     SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.status,b.road_status,b.updated_at,
       (SELECT d.id FROM warehouse_dispatches d WHERE d.organization_id=b.organization_id AND d.transport_batch_id=b.id AND d.status!='cancelled' ORDER BY d.updated_at DESC LIMIT 1) dispatch_id,
       COUNT(DISTINCT bo.order_id) order_count,GROUP_CONCAT(DISTINCT bo.order_id) order_ids,
       GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
       COUNT(CASE WHEN rd.row_no=1 THEN 1 END) uploaded_count,
       COALESCE(SUM(CASE WHEN rd.row_no=1 AND rd.review_status IN ('approved','archived') THEN 1 ELSE 0 END),0) approved_count,
       COALESCE(SUM(CASE WHEN rd.row_no=1 AND rd.review_status='rejected' THEN 1 ELSE 0 END),0) rejected_count
     FROM transport_batches b
     JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     LEFT JOIN ranked_documents rd ON rd.batch_id=b.id AND rd.order_id=bo.order_id
     WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'`;
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) total FROM transport_batches b
     WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
       AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=b.organization_id AND bo.batch_id=b.id AND bo.status!='removed')`,
  ).bind(user.organizationId, warehouse.id).first<{ total: number }>();
  const total = totalRow?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const batches = await env.DB.prepare(
    `${batchSummarySql}
     GROUP BY b.id
     ORDER BY CASE b.status WHEN 'planning' THEN 1 WHEN 'loading' THEN 2 ELSE 3 END,b.updated_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(user.organizationId, user.organizationId, warehouse.id, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<BatchRow>();
  let selectedBatch = batches.results.find((item) => item.id === requestedBatchId) ?? null;
  if (requestedBatchId && !selectedBatch) {
    selectedBatch = await env.DB.prepare(
      `${batchSummarySql} AND b.id=? GROUP BY b.id`,
    ).bind(user.organizationId, user.organizationId, warehouse.id, requestedBatchId).first<BatchRow>();
  }
  const contextBatches = selectedBatch && !batches.results.some((batch) => batch.id === selectedBatch?.id)
    ? [...batches.results, selectedBatch]
    : batches.results;
  const batchOrderIds = [
    ...new Set(
      contextBatches.flatMap((batch) =>
        batch.order_ids.split(",").filter(Boolean),
      ),
    ),
  ];
  const batchRequirements = await loadOrderLoadingDocumentRequirements(
    user.organizationId,
    batchOrderIds,
  );
  let batchDocumentStatuses: BatchDocumentStatusRow[] = [];
  for (const batchChunk of chunkD1Values(contextBatches, 1)) {
    const statusRows = await env.DB.prepare(
      `WITH ranked AS (
         SELECT bo.batch_id,bo.order_id,m.document_category,m.review_status,
           ROW_NUMBER() OVER(PARTITION BY bo.batch_id,bo.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
         FROM transport_batch_orders bo
         JOIN order_document_metadata m ON m.order_id=bo.order_id AND m.organization_id=bo.organization_id
         JOIN order_attachments a ON a.id=m.attachment_id AND a.organization_id=m.organization_id
         WHERE bo.organization_id=? AND bo.status!='removed'
           AND bo.batch_id IN (${d1Placeholders(batchChunk.length)})
           AND m.document_category IN (${documentCodes})
       )
       SELECT batch_id,order_id,document_category,review_status
       FROM ranked WHERE row_no=1`,
    )
      .bind(user.organizationId, ...batchChunk.map((batch) => batch.id))
      .all<BatchDocumentStatusRow>();
    batchDocumentStatuses.push(...statusRows.results);
  }
  const requirementsByOrder = new Map(
    batchRequirements.map((group) => [group.orderId, group]),
  );
  const documentStatusesByBatchOrder = new Map<
    string,
    BatchDocumentStatusRow[]
  >();
  for (const status of batchDocumentStatuses) {
    const key = `${status.batch_id}:${status.order_id}`;
    documentStatusesByBatchOrder.set(key, [
      ...(documentStatusesByBatchOrder.get(key) ?? []),
      status,
    ]);
  }
  const batchDocumentSummaries = contextBatches.map((batch) => {
    const orderIds = batch.order_ids.split(",").filter(Boolean);
    const orderSummaries = orderIds.map((orderId) =>
      summarizeLoadingDocumentRequirements(
        currentStageLoadingDocumentRequirements(requirementsByOrder.get(orderId)?.documents ?? []),
        documentStatusesByBatchOrder.get(`${batch.id}:${orderId}`) ?? [],
      ),
    );
    return {
      batchId: batch.id,
      requiredCount: orderSummaries.reduce(
        (sum, summary) => sum + summary.requiredCount,
        0,
      ),
      uploadedRequiredCount: orderSummaries.reduce(
        (sum, summary) => sum + summary.uploadedRequiredCount,
        0,
      ),
      approvedRequiredCount: orderSummaries.reduce(
        (sum, summary) => sum + summary.approvedRequiredCount,
        0,
      ),
      rejectedRequiredCount: orderSummaries.reduce(
        (sum, summary) => sum + summary.rejectedRequiredCount,
        0,
      ),
    };
  });
  let orders: OrderRow[] = [];
  let documents: DocumentRow[] = [];
  if (selectedBatch) {
    const [orderRows, documentRows] = await Promise.all([
      env.DB.prepare(
        `SELECT bo.order_id,o.order_number,c.name customer_name,bo.sequence_no,
           COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id),o.cargo_description) cargo_names
         FROM transport_batch_orders bo
         JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
         JOIN customers c ON c.id=o.customer_id
         WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
         ORDER BY bo.sequence_no,o.order_number`,
      ).bind(user.organizationId, selectedBatch.id).all<OrderRow>(),
      env.DB.prepare(
        `WITH ranked AS (
           SELECT m.order_id,m.attachment_id,m.document_category,a.file_name,a.content_type,m.review_status,a.created_at,
             ROW_NUMBER() OVER(PARTITION BY m.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
           FROM transport_batch_orders bo
           JOIN order_document_metadata m ON m.order_id=bo.order_id AND m.organization_id=bo.organization_id
           JOIN order_attachments a ON a.id=m.attachment_id AND a.organization_id=m.organization_id
           WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' AND m.document_category IN (${documentCodes})
         )
         SELECT order_id,attachment_id,document_category,file_name,content_type,review_status,created_at
         FROM ranked WHERE row_no=1 ORDER BY order_id,document_category`,
      ).bind(user.organizationId, selectedBatch.id).all<DocumentRow>(),
    ]);
    orders = orderRows.results;
    documents = documentRows.results;
  }
  const selectedDocumentRequirements = selectedBatch
    ? selectedBatch.order_ids
        .split(",")
        .filter(Boolean)
        .map((orderId) => requirementsByOrder.get(orderId))
        .filter(
          (group): group is OrderLoadingDocumentRequirements => Boolean(group),
        )
    : [];
  const selectedDocumentTypes = LOADING_DOCUMENTS.filter((definition) =>
    selectedDocumentRequirements.some((group) =>
      group.documents.some(
        (requirement) =>
          requirement.code === definition.code && requirement.isActive &&
          requirement.stageAvailable,
      ),
    ),
  );
  return {
    user,
    warehouse,
    batches: batches.results,
    selectedBatch,
    orders,
    documents,
    batchDocumentSummaries,
    selectedDocumentRequirements,
    selectedDocumentTypes,
    documentMutationPolicy: warehouseLoadingDocumentMutationPolicy,
    page,
    pageSize: PAGE_SIZE,
    pages,
    total,
  };
}

export async function action(
  { request }: Route.ActionArgs,
): Promise<{ formError?: string; success?: string }> {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  if (warehouse.warehouse_role === "overseas_destination") {
    return { formError: "境外目的仓不办理配载文件" };
  }
  await requireWarehouseAssignment(user, warehouse.id, "operator");
  return { formError: warehouseLoadingDocumentMutationPolicy.reason };
}

export default function WarehouseLoadingDocuments({ loaderData, actionData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const selected = loaderData.selectedBatch;
  const selectedSummary = selected
    ? loaderData.batchDocumentSummaries.find((item) => item.batchId === selected.id)
    : undefined;
  const selectedMissing = selectedSummary
    ? Math.max(0, selectedSummary.requiredCount - selectedSummary.uploadedRequiredCount)
    : null;
  const selectedReady = Boolean(selectedSummary && (
    selectedSummary.requiredCount === 0 ||
    (selectedSummary.approvedRequiredCount === selectedSummary.requiredCount && selectedSummary.rejectedRequiredCount === 0)
  ));
  const orderPagination = paginateList(loaderData.orders, readListPage(searchParams, "orderPage"));
  return <>
    <header className="page-header warehouse-loading-documents-header">
      <div><p className="eyebrow">LOAD DOCUMENTS</p><h1>配载文件</h1><p>按 PZ 配载单只读查看当前节点已到期文件的齐套状态；上传与审核由冻结工作流指定的业务或单证负责人办理。</p></div>
    </header>
    <ActionToast data={actionData}/>
    <section className="panel warehouse-loading-document-list">
      <div className="panel-header"><div><h2>配载单文件状态</h2><p>一行一张配载单；仓库核对当前节点已到期文件，缺失项由对应订单的当前负责人补齐。</p></div><span>共 {loaderData.total} 张</span></div>
      <div className="table-wrap"><table><thead><tr><th>配载单</th><th>运输线路</th><th>挂载订单</th><th>文件齐套</th><th>审核状态</th><th>配载状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
        {loaderData.batches.map((batch) => {
          const summary = loaderData.batchDocumentSummaries.find(
            (item) => item.batchId === batch.id,
          ) ?? {
            requiredCount: 0,
            uploadedRequiredCount: 0,
            approvedRequiredCount: 0,
            rejectedRequiredCount: 0,
          };
          const missing = Math.max(
            0,
            summary.requiredCount - summary.uploadedRequiredCount,
          );
          const pendingReview = Math.max(0, summary.requiredCount - summary.approvedRequiredCount);
          const filesReady = summary.requiredCount === 0 || (
            summary.approvedRequiredCount === summary.requiredCount && summary.rejectedRequiredCount === 0
          );
          const taskHref = loadingTaskHref(loaderData.warehouse.id, batch.id, batch.dispatch_id);
          return <tr key={batch.id} className={selected?.id === batch.id ? "selected-row" : undefined}>
            <td><strong>{batch.batch_number}</strong><small>{batch.batch_name || "未命名配载批次"}</small></td>
            <td>{batch.origin_location}<small>至 {batch.destination_location}</small></td>
            <td className="loading-document-orders-cell"><LoadingDocumentOrders count={batch.order_count} numbers={batch.order_numbers}/></td>
            <td><span className={`status-pill ${missing ? "danger" : "success"}`}>{summary.requiredCount === 0 ? "无必填文件" : missing ? `缺 ${missing} 项` : `${summary.requiredCount}/${summary.requiredCount} 已上传`}</span><small className={`loading-document-progress-feedback ${missing ? "" : filesReady ? "success" : "pending"}`}>{missing ? "仅统计当前工作流必填项" : summary.rejectedRequiredCount ? `上传完成，${summary.rejectedRequiredCount} 项已退回` : filesReady ? "文件齐套，可新建装车任务" : `上传完成，待审核 ${pendingReview} 项`}</small></td>
            <td>{summary.rejectedRequiredCount ? <span className="status-pill danger">{summary.rejectedRequiredCount} 项必填文件已退回</span> : summary.requiredCount === 0 ? <span className="status-pill success">无需审核</span> : summary.approvedRequiredCount === summary.requiredCount ? <span className="status-pill success">全部通过</span> : <span className="status-pill">{summary.approvedRequiredCount}/{summary.requiredCount} 已通过</span>}</td>
            <td><span className={`status-pill ${batch.status === "completed" ? "success" : ""}`}>{batchStatusLabel(batch.status)}</span><small>{roadStatusLabels[batch.road_status] ?? batch.road_status}</small></td>
            <td>{formatDateTime(batch.updated_at)}</td>
            <td><div className="warehouse-loading-document-actions"><Link className="secondary warehouse-loading-open-button" to={loadingDocumentsHref(loaderData.warehouse.id, loaderData.page, batch.id)}>打开文件</Link><Link className={batch.dispatch_id || !filesReady ? "secondary" : "primary warehouse-primary"} to={taskHref}>{batch.dispatch_id ? "进入装车与出库" : "新建装车任务"}</Link></div></td>
          </tr>;
        })}
        {!loaderData.batches.length && <tr><td colSpan={8} className="empty-state">当前仓库还没有 PZ 配载单。</td></tr>}
      </tbody></table></div>
      <LoadingDocumentsPagination loaderData={loaderData}/>
    </section>
    {selected && <Modal
      title={`${selected.batch_number} · 配载文件`}
      size="xwide"
      dialogClassName="warehouse-loading-document-modal"
      openSignal={selected.id}
      onClose={() => navigate(loadingDocumentsHref(loaderData.warehouse.id, loaderData.page))}
    >
      <section className="warehouse-loading-document-dialog">
        <header className="warehouse-loading-document-dialog-head">
          <div><strong>{selected.order_count} 票挂载订单</strong><span>{selected.origin_location} → {selected.destination_location}</span></div>
          <p>{loaderData.documentMutationPolicy.reason}。</p>
        </header>
        {selectedSummary && selectedMissing === 0 && selected && <div className={`warehouse-loading-document-completion ${selectedReady ? "success" : "pending"}`} role="status" aria-live="polite"><div><strong>{selected.dispatch_id ? "装车任务已创建" : selectedSummary.rejectedRequiredCount ? "必填文件已被退回" : selectedReady ? "文件齐套完成" : "全部必填文件已上传"}</strong><span>{selected.dispatch_id ? "可直接进入装车与出库继续办理。" : selectedSummary.rejectedRequiredCount ? `${selectedSummary.rejectedRequiredCount} 项文件需重新上传并通过审核，完成后即可创建装车任务。` : selectedReady ? "当前配载单的必填文件已全部通过，可直接新建装车任务。" : `还有 ${Math.max(0, selectedSummary.requiredCount - selectedSummary.approvedRequiredCount)} 项待审核，审核通过后即可创建装车任务。`}</span></div><Link className={selectedReady ? "primary warehouse-primary" : "secondary"} to={loadingTaskHref(loaderData.warehouse.id, selected.id, selected.dispatch_id)}>{selected.dispatch_id ? "进入装车与出库" : "新建装车任务"}</Link></div>}
        <div className="table-wrap warehouse-loading-document-matrix"><table><thead><tr><th>订单 / 客户</th><th>货物</th>{loaderData.selectedDocumentTypes.map((item) => <th key={item.code}>{item.name}</th>)}<th>操作</th></tr></thead><tbody>
          {orderPagination.items.map((order) => {
            const requirements = loaderData.selectedDocumentRequirements.find(
              (group) => group.orderId === order.order_id,
            )?.documents ?? [];
            return <tr key={order.order_id}><td><strong>{order.order_number}</strong><small>{order.customer_name}</small></td><td>{order.cargo_names || "未填写"}</td>{loaderData.selectedDocumentTypes.map((type) => {
              const requirement = requirements.find((item) => item.code === type.code);
              const document = loaderData.documents.find((item) => item.order_id === order.order_id && item.document_category === type.code);
              if (!requirement?.isActive) return <td key={type.code}><span className="status-pill">不适用</span></td>;
              return <td key={type.code} className={`loading-document-requirement-cell ${document ? "provided" : requirement.isRequired ? "required" : "optional"}`} aria-label={`${type.name}，${requirement.isRequired ? "必填" : "选填"}`}>{document ? <><a href={warehouseDocumentHref(document, loaderData.warehouse.id)} target="_blank" rel="noreferrer">{document.file_name}</a><small><span className={`status-pill ${["approved","archived"].includes(document.review_status) ? "success" : document.review_status === "rejected" ? "danger" : ""}`}>{reviewStatusLabel(document.review_status)}</span></small></> : <span className={`status-pill ${requirement.isRequired ? "danger" : ""}`}>{requirement.isRequired ? "待上传" : "尚未上传"}</span>}</td>;
            })}<td><span className="status-pill">仓库只读</span></td></tr>;
          })}
        </tbody></table></div>
        <QueryPagination {...orderPagination} pageParam="orderPage" unit="票订单"/>
      </section>
    </Modal>}
  </>;
}

function LoadingDocumentOrders({ count, numbers }: { count: number; numbers: string }) {
  const orders = numbers.split(/[,、]/).map((number) => number.trim()).filter(Boolean);
  const readableNumbers = orders.join("、") || "暂无挂载订单";
  const summary = <><strong className="loading-document-order-count">{count} 票</strong><span className="loading-document-order-list" title={readableNumbers}>{readableNumbers}</span></>;
  if (orders.length <= 1) return <div className="loading-document-order-summary">{summary}</div>;
  return <details className="loading-document-orders">
    <summary>{summary}<span className="loading-document-order-toggle">查看全部</span></summary>
    <div className="loading-document-order-options" role="list" aria-label={`${count} 票挂载订单`}>
      {orders.map((number, index) => <span role="listitem" key={`${number}-${index}`}>{number}</span>)}
    </div>
  </details>;
}

function loadingDocumentsHref(warehouseId: string, page: number, batchId?: string) {
  const params = new URLSearchParams({ warehouseId, page: String(page) });
  if (batchId) params.set("batchId", batchId);
  return `/warehouse/loading-documents?${params}`;
}

function loadingTaskHref(warehouseId: string, batchId: string, dispatchId?: string | null) {
  const params = new URLSearchParams({
    warehouseId,
    view: dispatchId ? "execution" : "create",
  });
  if (dispatchId) params.set("dispatchId", dispatchId);
  else params.set("batchId", batchId);
  return `/warehouse/outbound?${params}`;
}

function LoadingDocumentsPagination({ loaderData }: { loaderData: Route.ComponentProps["loaderData"] }) {
  const previous = loaderData.page - 1;
  const next = loaderData.page + 1;
  const count = Math.min(5, loaderData.pages);
  const start = Math.max(1, Math.min(loaderData.page - 2, loaderData.pages - count + 1));
  const pageNumbers = Array.from({ length: count }, (_, index) => start + index);
  const href = (page: number) => loadingDocumentsHref(loaderData.warehouse.id, page);
  return <footer className="pagination consolidation-pagination warehouse-loading-document-pagination" aria-label="配载文件分页">
    <span>每页 {loaderData.pageSize} 张 · 第 {loaderData.page} / {loaderData.pages} 页 · 共 {loaderData.total} 张</span>
    <div>
      {previous >= 1 ? <Link className="secondary" to={href(previous)}>上一页</Link> : <span className="secondary disabled" aria-disabled="true">上一页</span>}
      {pageNumbers.map((page) => page === loaderData.page
        ? <span key={page} className="consolidation-pagination-current" aria-current="page">{page}</span>
        : <Link key={page} className="secondary" to={href(page)} aria-label={`第 ${page} 页`}>{page}</Link>)}
      {next <= loaderData.pages ? <Link className="secondary" to={href(next)}>下一页</Link> : <span className="secondary disabled" aria-disabled="true">下一页</span>}
    </div>
  </footer>;
}

function warehouseDocumentHref(document: DocumentRow, warehouseId: string) {
  return `/warehouse/document-files/order/${document.attachment_id}?warehouseId=${encodeURIComponent(warehouseId)}&mode=view`;
}

function batchStatusLabel(status: string) { return ({ planning: "待完善", loading: "待装车", completed: "已完成" } as Record<string, string>)[status] ?? status; }
function reviewStatusLabel(status: string) { return ({ pending: "待审核", approved: "已通过", rejected: "已退回", archived: "已归档" } as Record<string, string>)[status] ?? status; }

function formatDateTime(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
export function meta() { return [{ title: "配载文件 | International TMS" }]; }
