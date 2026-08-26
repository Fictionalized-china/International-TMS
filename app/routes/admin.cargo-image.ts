import { env } from "cloudflare:workers";

import type { Route } from "./+types/admin.cargo-image";
import { requireSessionUser } from "../lib/auth.server";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";

type StoredCargoImage = {
  file_name: string;
  content_type: string;
  data_url: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const image = await env.DB.prepare(
    "SELECT file_name,content_type,data_url FROM order_cargo_images WHERE id=? AND organization_id=?",
  )
    .bind(params.imageId, current.organizationId)
    .first<StoredCargoImage>();
  if (!image) throw new Response("货物图片不存在", { status: 404 });

  return storedDataUrlResponse({
    dataUrl: image.data_url,
    fileName: image.file_name,
    contentType: image.content_type,
    disposition: "inline",
  });
}
