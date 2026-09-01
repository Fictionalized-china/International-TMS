import { env } from "cloudflare:workers";

import type { Route } from "./+types/admin.quotation-field-file";
import { requireSessionUser } from "../lib/auth.server";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "quote.view");
  const file = await env.DB.prepare(
    `SELECT file_name,content_type,data_url
     FROM quotation_workflow_field_values
     WHERE id=? AND organization_id=? AND file_name IS NOT NULL AND data_url IS NOT NULL`,
  ).bind(params.valueId,current.organizationId).first<{
    file_name:string;
    content_type:string;
    data_url:string;
  }>();
  if (!file) throw new Response("文件不存在", { status:404 });
  return storedDataUrlResponse({
    dataUrl:file.data_url,
    fileName:file.file_name,
    contentType:file.content_type,
    disposition:new URL(request.url).searchParams.get("mode") === "view" ? "inline" : "attachment",
  });
}
