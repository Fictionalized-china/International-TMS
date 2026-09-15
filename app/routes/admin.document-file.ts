import { env } from "cloudflare:workers";

import type { Route } from "./+types/admin.document-file";
import { requireSessionUser } from "../lib/auth.server";
import { batchVisibilitySql, orderVisibilitySql } from "../lib/order-access.server";
import { canReadScopedDocument } from "../lib/order-document-visibility";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";

type StoredFile = {
  file_name: string;
  content_type: string;
  data_url: string;
  document_category: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const mode = new URL(request.url).searchParams.get("mode");
  const current = await requireSessionUser(request, "order.view");
  const sourceType = params.sourceType;
  if (sourceType !== "order" && sourceType !== "batch")
    throw new Response("文件来源无效", { status: 404 });

  const file = sourceType === "order"
    ? await findVisibleOrderFile(current, params.fileId)
    : await findVisibleBatchFile(current, params.fileId);
  if (!file) throw new Response("文件不存在", { status: 404 });
  if (!canReadScopedDocument(current, file.document_category)) {
    throw new Response("没有权限查看该结算文件", { status: 403 });
  }

  const disposition = mode === "view"
    ? "inline"
    : "attachment";
  return storedDataUrlResponse({
    dataUrl: file.data_url,
    fileName: file.file_name,
    contentType: file.content_type,
    disposition,
  });
}

async function findVisibleOrderFile(
  current: Awaited<ReturnType<typeof requireSessionUser>>,
  fileId: string | undefined,
) {
  const visibility = orderVisibilitySql(current, "o");
  return env.DB.prepare(
    `SELECT a.file_name,a.content_type,a.data_url,
            COALESCE(m.document_category,'other') document_category
       FROM order_attachments a
       JOIN transport_orders o
         ON o.id=a.order_id AND o.organization_id=a.organization_id
       LEFT JOIN order_document_metadata m
         ON m.attachment_id=a.id
        AND m.order_id=a.order_id
        AND m.organization_id=a.organization_id
      WHERE a.id=? AND a.organization_id=? AND ${visibility.sql}`,
  )
    .bind(fileId, current.organizationId, ...visibility.values)
    .first<StoredFile>();
}

async function findVisibleBatchFile(
  current: Awaited<ReturnType<typeof requireSessionUser>>,
  fileId: string | undefined,
) {
  const visibility = batchVisibilitySql(current, "b");
  return env.DB.prepare(
    `SELECT d.file_name,d.content_type,d.data_url,d.document_category
       FROM transport_batch_documents d
       JOIN transport_batches b
         ON b.id=d.batch_id AND b.organization_id=d.organization_id
      WHERE d.id=? AND d.organization_id=? AND ${visibility.sql}`,
  )
    .bind(fileId, current.organizationId, ...visibility.values)
    .first<StoredFile>();
}
