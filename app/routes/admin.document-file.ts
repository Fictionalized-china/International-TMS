import { env } from "cloudflare:workers";

import type { Route } from "./+types/admin.document-file";
import { requireSessionUser } from "../lib/auth.server";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";

type StoredFile = {
  file_name: string;
  content_type: string;
  data_url: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const sourceType = params.sourceType;
  if (sourceType !== "order" && sourceType !== "batch")
    throw new Response("文件来源无效", { status: 404 });

  const table = sourceType === "order" ? "order_attachments" : "transport_batch_documents";
  const file = await env.DB.prepare(
    `SELECT file_name,content_type,data_url FROM ${table} WHERE id=? AND organization_id=?`,
  )
    .bind(params.fileId, current.organizationId)
    .first<StoredFile>();
  if (!file) throw new Response("文件不存在", { status: 404 });

  const disposition = new URL(request.url).searchParams.get("mode") === "view"
    ? "inline"
    : "attachment";
  return storedDataUrlResponse({
    dataUrl: file.data_url,
    fileName: file.file_name,
    contentType: file.content_type,
    disposition,
  });
}
