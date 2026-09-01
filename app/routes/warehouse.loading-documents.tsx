import { env } from "cloudflare:workers";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/warehouse.loading-documents";
import { Modal } from "../components/Modal";
import { writeAudit } from "../lib/audit.server";
import { requireSessionUser } from "../lib/auth.server";
import { synchronizeOrderDocumentsModuleStatus } from "../lib/documents-module-status.server";
import { maxInlineOrderDocumentBytes } from "../lib/order-documents";
import {
  loadingOrderDocumentDefinitions,
  summarizeLoadingDocumentRequirements,
  type EffectiveLoadingDocumentRequirement,
  type LoadingOrderDocumentCode,
  type OrderLoadingDocumentRequirements,
} from "../lib/loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "../lib/loading-document-requirements.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { valueOf } from "../lib/validation";

const LOADING_DOCUMENTS = loadingOrderDocumentDefinitions;
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
  const documentCodes = LOADING_DOCUMENTS.map((item) => `'${item.code}'`).join(",");
  const batches = await env.DB.prepare(
    `WITH ranked_documents AS (
       SELECT bo.batch_id,m.order_id,m.document_category,m.review_status,
         ROW_NUMBER() OVER(PARTITION BY bo.batch_id,m.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
       FROM transport_batch_orders bo
       JOIN order_document_metadata m ON m.order_id=bo.order_id AND m.organization_id=bo.organization_id
       JOIN order_attachments a ON a.id=m.attachment_id AND a.organization_id=m.organization_id
       WHERE bo.organization_id=? AND bo.status!='removed' AND m.document_category IN (${documentCodes})
     )
     SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.status,b.road_status,b.updated_at,
       COUNT(DISTINCT bo.order_id) order_count,GROUP_CONCAT(DISTINCT bo.order_id) order_ids,
       GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
       COUNT(CASE WHEN rd.row_no=1 THEN 1 END) uploaded_count,
       COALESCE(SUM(CASE WHEN rd.row_no=1 AND rd.review_status IN ('approved','archived') THEN 1 ELSE 0 END),0) approved_count,
       COALESCE(SUM(CASE WHEN rd.row_no=1 AND rd.review_status='rejected' THEN 1 ELSE 0 END),0) rejected_count
     FROM transport_batches b
     JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     LEFT JOIN ranked_documents rd ON rd.batch_id=b.id AND rd.order_id=bo.order_id
     WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
     GROUP BY b.id
     ORDER BY CASE b.status WHEN 'planning' THEN 1 WHEN 'loading' THEN 2 ELSE 3 END,b.updated_at DESC
     LIMIT 100`,
  ).bind(user.organizationId, user.organizationId, warehouse.id).all<BatchRow>();
  const batchOrderIds = [
    ...new Set(
      batches.results.flatMap((batch) =>
        batch.order_ids.split(",").filter(Boolean),
      ),
    ),
  ];
  const batchRequirements = await loadOrderLoadingDocumentRequirements(
    user.organizationId,
    batchOrderIds,
  );
  let batchDocumentStatuses: BatchDocumentStatusRow[] = [];
  for (const batchChunk of chunkD1Values(batches.results, 1)) {
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
  const batchDocumentSummaries = batches.results.map((batch) => {
    const orderIds = batch.order_ids.split(",").filter(Boolean);
    const orderSummaries = orderIds.map((orderId) =>
      summarizeLoadingDocumentRequirements(
        requirementsByOrder.get(orderId)?.documents ?? [],
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
  const selectedBatch = batches.results.find((item) => item.id === requestedBatchId) ?? null;
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
          requirement.code === definition.code && requirement.isActive,
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
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  if (warehouse.warehouse_role === "overseas_destination") {
    return { formError: "境外目的仓不办理配载文件" };
  }
  await requireWarehouseAssignment(user, warehouse.id, "operator");
  const form = await request.formData();
  if (valueOf(form, "intent") !== "upload_many") return { formError: "操作类型无效" };
  const batchId = valueOf(form, "batchId");
  const orderId = valueOf(form, "orderId");
  const order = await env.DB.prepare(
    `SELECT o.customer_id,o.order_number,b.batch_number
     FROM transport_batches b
     JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     WHERE b.id=? AND b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled' AND o.id=?`,
  ).bind(batchId, user.organizationId, warehouse.id, orderId).first<{ customer_id: string; order_number: string; batch_number: string }>();
  if (!order) return { formError: "配载单或挂载订单无效" };
  const [requirementGroup] = await loadOrderLoadingDocumentRequirements(
    user.organizationId,
    [orderId],
  );
  const activeDocumentTypes =
    requirementGroup?.documents.filter((document) => document.isActive) ?? [];
  const selectedFiles = activeDocumentTypes.flatMap((documentType) => {
    const file = form.get(`attachment_${documentType.code}`);
    return file instanceof File && file.size > 0 ? [{ documentType, file }] : [];
  });
  if (!selectedFiles.length) return { formError: "请至少选择一个需要上传的订单文件" };
  for (const item of selectedFiles) {
    const fileError = validateDocumentFile(item.file);
    if (fileError) return { formError: `${item.documentType.name}：${fileError}` };
  }
  const now = new Date().toISOString();
  const uploads = await Promise.all(selectedFiles.map(async ({ documentType, file }) => ({
    attachmentId: crypto.randomUUID(),
    documentType,
    file,
    dataUrl: await toDataUrl(file),
  })));
  await env.DB.batch(uploads.flatMap(({ attachmentId, documentType, file, dataUrl }) => [
    env.DB.prepare(
      "INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)",
    ).bind(attachmentId, user.organizationId, orderId, order.customer_id, file.name, file.type, file.size, dataUrl, user.userId, now),
    env.DB.prepare(
      "INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,reviewed_by_user_id,reviewed_at,updated_at) VALUES(?,?,?,?,?,0,'approved',?,?,?)",
    ).bind(attachmentId, user.organizationId, orderId, documentType.code, `${order.batch_number} 配载文件·${documentType.name}`, user.userId, now, now),
  ]));
  await synchronizeOrderDocumentsModuleStatus({
    organizationId: user.organizationId,
    orderId,
    actorUserId: user.userId,
    now,
    source: "warehouse_upload",
  });
  await writeAudit({
    request,
    action: "warehouse.loading_documents.upload_many",
    resourceType: "transport_order",
    resourceId: orderId,
    organizationId: user.organizationId,
    actorUserId: user.userId,
    metadata: {
      warehouseId: warehouse.id,
      batchId,
      batchNumber: order.batch_number,
      orderId,
      orderNumber: order.order_number,
      autoApproved: true,
      files: uploads.map(({ documentType, file }) => ({ documentCategory: documentType.code, fileName: file.name })),
    },
  });
  return { success: `${order.batch_number} · ${order.order_number} 的 ${uploads.length} 个文件已上传并自动通过`, uploadedAt: now };
}

export default function WarehouseLoadingDocuments({ loaderData, actionData }: Route.ComponentProps) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const selected = loaderData.selectedBatch;
  return <>
    <header className="page-header warehouse-loading-documents-header">
      <div><p className="eyebrow">LOAD DOCUMENTS</p><h1>配载文件</h1><p>拼车发运文件的统一管理入口：按 PZ 配载单集中上传并查看齐套状态，文件仍按订单归档和追溯。</p></div>
    </header>
    {!selected && (actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`} role={actionData.formError ? "alert" : "status"}>{actionData.formError ?? actionData.success}</div>}
    <section className="panel warehouse-loading-document-list">
      <div className="panel-header"><div><h2>配载单文件状态</h2><p>一行一张配载单；请优先在这里补齐文件，待装车页只处理创建任务时仍然缺失的项目。</p></div><span>{loaderData.batches.length} 张</span></div>
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
          return <tr key={batch.id} className={selected?.id === batch.id ? "selected-row" : undefined}>
            <td><strong>{batch.batch_number}</strong><small>{batch.batch_name || "未命名配载批次"}</small></td>
            <td>{batch.origin_location}<small>至 {batch.destination_location}</small></td>
            <td><strong>{batch.order_count} 票</strong><small className="loading-document-order-list">{batch.order_numbers}</small></td>
            <td><span className={`status-pill ${missing ? "danger" : "success"}`}>{summary.requiredCount === 0 ? "无必填文件" : missing ? `缺 ${missing} 项` : `${summary.requiredCount}/${summary.requiredCount} 已上传`}</span><small>仅统计当前工作流必填项</small></td>
            <td>{summary.rejectedRequiredCount ? <span className="status-pill danger">{summary.rejectedRequiredCount} 项必填文件已退回</span> : summary.requiredCount === 0 ? <span className="status-pill success">无需审核</span> : summary.approvedRequiredCount === summary.requiredCount ? <span className="status-pill success">全部通过</span> : <span className="status-pill">{summary.approvedRequiredCount}/{summary.requiredCount} 已通过</span>}</td>
            <td><span className={`status-pill ${batch.status === "completed" ? "success" : ""}`}>{batchStatusLabel(batch.status)}</span><small>{roadStatusLabels[batch.road_status] ?? batch.road_status}</small></td>
            <td>{formatDateTime(batch.updated_at)}</td>
            <td><Link className="secondary warehouse-loading-open-button" to={`/warehouse/loading-documents?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}&batchId=${encodeURIComponent(batch.id)}`}>打开文件</Link></td>
          </tr>;
        })}
        {!loaderData.batches.length && <tr><td colSpan={8} className="empty-state">当前仓库还没有 PZ 配载单。</td></tr>}
      </tbody></table></div>
    </section>
    {selected && <Modal
      title={`${selected.batch_number} · 配载文件`}
      size="xwide"
      dialogClassName="warehouse-loading-document-modal"
      openSignal={selected.id}
      onClose={() => navigate(`/warehouse/loading-documents?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`)}
    >
      <section className="warehouse-loading-document-dialog">
        <header className="warehouse-loading-document-dialog-head">
          <div><strong>{selected.order_count} 票挂载订单</strong><span>{selected.origin_location} → {selected.destination_location}</span></div>
          <p>在对应订单行点击“上传文件”；新文件成为当前版本，历史版本继续保留。</p>
        </header>
        {(actionData?.success || actionData?.formError) && <div className={`warehouse-loading-document-message ${actionData.formError ? "error" : "success"}`} role={actionData.formError ? "alert" : "status"} aria-live="polite">{actionData.formError ?? actionData.success}</div>}
        <div className="table-wrap warehouse-loading-document-matrix"><table><thead><tr><th>订单 / 客户</th><th>货物</th>{loaderData.selectedDocumentTypes.map((item) => <th key={item.code}>{item.name}</th>)}<th>操作</th></tr></thead><tbody>
          {loaderData.orders.map((order) => {
            const requirements = loaderData.selectedDocumentRequirements.find(
              (group) => group.orderId === order.order_id,
            )?.documents ?? [];
            const activeRequirements = requirements.filter(
              (requirement) => requirement.isActive,
            );
            return <tr key={order.order_id}><td><strong>{order.order_number}</strong><small>{order.customer_name}</small></td><td>{order.cargo_names || "未填写"}</td>{loaderData.selectedDocumentTypes.map((type) => {
              const requirement = requirements.find((item) => item.code === type.code);
              const document = loaderData.documents.find((item) => item.order_id === order.order_id && item.document_category === type.code);
              if (!requirement?.isActive) return <td key={type.code}><span className="status-pill">不适用</span></td>;
              return <td key={type.code}>{document ? <><a href={warehouseDocumentHref(document, loaderData.warehouse.id)} target="_blank" rel="noreferrer">{document.file_name}</a><small><span className={`status-pill ${["approved","archived"].includes(document.review_status) ? "success" : document.review_status === "rejected" ? "danger" : ""}`}>{reviewStatusLabel(document.review_status)}</span> · {requirement.isRequired ? "必填" : "选填"}</small></> : <span className={`status-pill ${requirement.isRequired ? "danger" : ""}`}>{requirement.isRequired ? "待上传" : "选填"}</span>}</td>;
            })}<td><OrderDocumentUploadModal
              order={order}
              documents={loaderData.documents.filter((item) => item.order_id === order.order_id)}
              documentTypes={activeRequirements}
              batchId={selected.id}
              warehouseId={loaderData.warehouse.id}
              busy={busy}
              actionData={actionData}
            /></td></tr>;
          })}
        </tbody></table></div>
      </section>
    </Modal>}
  </>;
}

function OrderDocumentUploadModal({
  order,
  documents,
  documentTypes,
  batchId,
  warehouseId,
  busy,
  actionData,
}: {
  order: OrderRow;
  documents: DocumentRow[];
  documentTypes: EffectiveLoadingDocumentRequirement[];
  batchId: string;
  warehouseId: string;
  busy: boolean;
  actionData: Route.ComponentProps["actionData"];
}) {
  const controlPrefix = `order-document-upload-${useId().replace(/:/g, "")}`;
  const submit = useSubmit();
  const movingToPreview = useRef(false);
  const [selectedFiles, setSelectedFiles] = useState<Partial<Record<LoadingDocumentCode, File>>>({});
  const [selectionSignal, setSelectionSignal] = useState(0);
  const [previewSignal, setPreviewSignal] = useState(0);
  const selectedCount = Object.values(selectedFiles).filter(Boolean).length;
  useEffect(() => {
    if (actionData?.uploadedAt) setSelectedFiles({});
  }, [actionData?.uploadedAt]);
  const openPreview = (closeSelection: () => void) => {
    movingToPreview.current = true;
    closeSelection();
    setPreviewSignal((value) => value + 1);
  };
  const uploadSelectedFiles = () => {
    const formData = new FormData();
    formData.set("intent", "upload_many");
    formData.set("batchId", batchId);
    formData.set("orderId", order.order_id);
    formData.set("warehouseId", warehouseId);
    for (const documentType of documentTypes) {
      const file = selectedFiles[documentType.code];
      if (file) formData.set(`attachment_${documentType.code}`, file);
    }
    submit(formData, { method: "post", encType: "multipart/form-data" });
  };
  if (!documentTypes.length) {
    return <span className="status-pill success">当前无配置文件</span>;
  }
  return <>
    <Modal
      title={`上传订单文件 · ${order.order_number}`}
      triggerLabel="上传文件"
      triggerClassName="secondary warehouse-order-upload-trigger"
      size="wide"
      openSignal={selectionSignal || undefined}
      closeSignal={actionData?.uploadedAt}
      onClose={() => {
        if (movingToPreview.current) {
          movingToPreview.current = false;
          return;
        }
        setSelectedFiles({});
      }}
    >{({ close }) => <section className="warehouse-order-document-upload-form">
      <div className="warehouse-order-document-context"><span>挂载订单</span><strong>{order.order_number}</strong><small>{order.customer_name} · {order.cargo_names || "货物名称未填写"}</small></div>
      <div className="warehouse-order-document-picker" role="table" aria-label="选择订单文件">
        <div className="warehouse-order-document-picker-head" role="row"><span role="columnheader">文件类型</span><span role="columnheader">当前文件</span><span role="columnheader">本次选择</span><span role="columnheader">操作</span></div>
        {documentTypes.map((documentType) => {
          const current = documents.find((item) => item.document_category === documentType.code);
          const selectedFile = selectedFiles[documentType.code];
          const inputId = `${controlPrefix}-${documentType.code}`;
          return <div className="warehouse-order-document-picker-row" role="row" key={documentType.code}>
            <strong role="cell">{documentType.name}<small>{documentType.isRequired ? "必填" : "选填"}</small></strong>
            <span role="cell">{current ? <><a href={warehouseDocumentHref(current, warehouseId)} target="_blank" rel="noreferrer">{current.file_name}</a><small>{reviewStatusLabel(current.review_status)}</small></> : <em>尚未上传</em>}</span>
            <span role="cell" className={selectedFile ? "selected" : ""}>{selectedFile ? <><b>{selectedFile.name}</b><small>{formatFileSize(selectedFile.size)}</small></> : <em>本次不变更</em>}</span>
            <span role="cell"><input id={inputId} name={`attachment_${documentType.code}`} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              setSelectedFiles((currentFiles) => ({ ...currentFiles, [documentType.code]: file }));
            }}/><label className="secondary" htmlFor={inputId}>{selectedFile ? "重新选择" : "选择文件"}</label></span>
          </div>;
        })}
      </div>
      <p className="warehouse-order-document-help">支持 PDF、Word、Excel、JPG、PNG、WEBP；单个文件不超过 1.2MB。本次未选择的已有文件不会改变。</p>
      <footer><button type="button" className="secondary" onClick={() => { setSelectedFiles({}); close(); }}>取消</button><button type="button" className="primary" disabled={!selectedCount} onClick={() => openPreview(close)}>查看并确认（{selectedCount}）</button></footer>
    </section>}</Modal>
    <Modal title={`文件总览 · ${order.order_number}`} size="xwide" dialogClassName="warehouse-order-document-preview-modal" openSignal={previewSignal || undefined} closeSignal={actionData?.uploadedAt}>{({ close: closePreview }) =>
      <section className="warehouse-order-document-preview">
        <header><div><span>第二步 / 共两步</span><strong>确认本次订单文件</strong></div><p>确认后才会正式上传；已有同类型文件将保留为历史版本。</p></header>
        {actionData?.formError && <div className="alert error" role="alert">{actionData.formError}</div>}
        <div className="table-wrap"><table><thead><tr><th>文件类型</th><th>当前版本</th><th>本次文件</th><th>确认结果</th></tr></thead><tbody>{documentTypes.map((documentType) => {
          const current = documents.find((item) => item.document_category === documentType.code);
          const selectedFile = selectedFiles[documentType.code];
          return <tr key={documentType.code}><td><strong>{documentType.name}</strong><small>{documentType.isRequired ? "必填" : "选填"}</small></td><td>{current ? <a href={warehouseDocumentHref(current, warehouseId)} target="_blank" rel="noreferrer">{current.file_name}</a> : "—"}</td><td>{selectedFile ? <><strong>{selectedFile.name}</strong><small>{formatFileSize(selectedFile.size)} · {selectedFile.type || "未知格式"}</small></> : "—"}</td><td><span className={`status-pill ${selectedFile ? "success" : current || !documentType.isRequired ? "" : "danger"}`}>{selectedFile ? current ? "上传新版本" : "新增文件" : current ? "保留当前" : documentType.isRequired ? "仍缺失" : "选填未提供"}</span></td></tr>;
        })}</tbody></table></div>
        <div className="warehouse-order-document-preview-grid">{documentTypes.map((documentType) => <OrderDocumentPreview key={documentType.code} documentType={documentType} selectedFile={selectedFiles[documentType.code]} current={documents.find((item) => item.document_category === documentType.code)} warehouseId={warehouseId}/>)}</div>
        <footer><span>本次将上传 {selectedCount} 个文件</span><div><button type="button" className="secondary" onClick={() => { closePreview(); setSelectionSignal((value) => value + 1); }}>返回修改</button><button type="button" className="primary" disabled={busy} onClick={uploadSelectedFiles}>{busy ? "正在上传…" : "确认并上传"}</button></div></footer>
      </section>
    }</Modal>
  </>;
}

function OrderDocumentPreview({ documentType, selectedFile, current, warehouseId }: { documentType: EffectiveLoadingDocumentRequirement; selectedFile?: File; current?: DocumentRow; warehouseId: string }) {
  const [objectUrl, setObjectUrl] = useState("");
  useEffect(() => {
    if (!selectedFile) { setObjectUrl(""); return; }
    try {
      const url = URL.createObjectURL(selectedFile);
      setObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch {
      setObjectUrl("");
    }
  }, [selectedFile]);
  const previewUrl = selectedFile ? objectUrl : current ? warehouseDocumentHref(current, warehouseId) : "";
  const contentType = selectedFile?.type || current?.content_type || "";
  return <article className={!previewUrl ? "empty" : ""}>
    <header><strong>{documentType.name}</strong><span>{selectedFile ? "本次选择" : current ? "当前版本" : "尚未上传"}</span></header>
    {previewUrl && contentType.startsWith("image/") ? <img src={previewUrl} alt={`${documentType.name}预览`}/> : previewUrl && contentType === "application/pdf" ? <iframe src={previewUrl} title={`${documentType.name} PDF 预览`}/> : <div><b>{selectedFile?.name || current?.file_name || "无文件"}</b><small>{previewUrl ? "该格式请在新窗口打开检查" : "本次仍未提供该文件"}</small>{previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer">{selectedFile ? "打开本次文件" : "打开当前文件"}</a>}</div>}
  </article>;
}

function warehouseDocumentHref(document: DocumentRow, warehouseId: string) {
  return `/warehouse/document-files/order/${document.attachment_id}?warehouseId=${encodeURIComponent(warehouseId)}&mode=view`;
}

function validateDocumentFile(file: File) {
  const allowed = new Set(["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "image/jpeg", "image/png", "image/webp"]);
  if (file.size > maxInlineOrderDocumentBytes) return "当前数据库直存模式下单个文件不能超过1.2MB";
  if (!allowed.has(file.type)) return "仅支持 PDF、Word、Excel 和图片文件";
  return null;
}
async function toDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:${file.type};base64,${btoa(binary)}`;
}
function batchStatusLabel(status: string) { return ({ planning: "待完善", loading: "待装车", completed: "已完成" } as Record<string, string>)[status] ?? status; }
function reviewStatusLabel(status: string) { return ({ pending: "待审核", approved: "已通过", rejected: "已退回", archived: "已归档" } as Record<string, string>)[status] ?? status; }
function formatDateTime(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
function formatFileSize(size: number) { return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`; }
export function meta() { return [{ title: "配载文件 | International TMS" }]; }
