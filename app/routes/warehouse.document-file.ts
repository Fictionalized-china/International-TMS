import { env } from "cloudflare:workers";

import type { Route } from "./+types/warehouse.document-file";
import { requireSessionUser } from "../lib/auth.server";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";

type StoredWarehouseDocument = {
  file_name: string;
  content_type: string;
  data_url: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouse = (await loadWarehouseContext(request, user)).selected;
  const document = params.sourceType === "order"
    ? await env.DB.prepare(
      `SELECT a.file_name,a.content_type,a.data_url
         FROM order_attachments a
        WHERE a.id=? AND a.organization_id=?
          AND EXISTS(
            SELECT 1 FROM shipments s
            JOIN warehouse_packages p ON p.shipment_id=s.id AND p.organization_id=s.organization_id
            WHERE s.organization_id=a.organization_id AND s.order_id=a.order_id AND p.warehouse_id=?
          )`,
    )
      .bind(params.fileId, user.organizationId, warehouse.id)
      .first<StoredWarehouseDocument>()
    : params.sourceType === "batch"
      ? await env.DB.prepare(
        `SELECT d.file_name,d.content_type,d.data_url
           FROM transport_batch_documents d
           JOIN transport_batches b ON b.id=d.batch_id AND b.organization_id=d.organization_id
          WHERE d.id=? AND d.organization_id=? AND b.warehouse_id=?`,
      )
        .bind(params.fileId, user.organizationId, warehouse.id)
        .first<StoredWarehouseDocument>()
      : params.sourceType === "exception"
        ? await env.DB.prepare(
          `SELECT a.file_name,a.content_type,a.data_url
             FROM warehouse_exception_attachments a
             JOIN warehouse_exceptions e ON e.id=a.exception_id AND e.organization_id=a.organization_id
             JOIN warehouse_packages p ON p.id=e.package_id AND p.organization_id=e.organization_id
            WHERE a.id=? AND a.organization_id=? AND p.warehouse_id=?`,
        )
          .bind(params.fileId, user.organizationId, warehouse.id)
          .first<StoredWarehouseDocument>()
        : null;
  if (!document) throw new Response("文件不存在或不属于当前仓库", { status: 404 });

  const disposition = new URL(request.url).searchParams.get("mode") === "view"
    ? "inline"
    : "attachment";
  return storedDataUrlResponse({
    dataUrl: document.data_url,
    fileName: document.file_name,
    contentType: document.content_type,
    disposition,
  });
}
