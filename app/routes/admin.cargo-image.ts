import { env } from "cloudflare:workers";

import type { Route } from "./+types/admin.cargo-image";
import { requireSessionUser } from "../lib/auth.server";
import { orderVisibilitySql } from "../lib/order-access.server";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";

type StoredCargoImage = {
  file_name: string;
  content_type: string;
  data_url: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.module.cargo.manage");
  const visibility = orderVisibilitySql(current, "o");
  const image = await env.DB.prepare(
    `SELECT image.file_name,image.content_type,image.data_url
       FROM order_cargo_images image
       JOIN order_cargo_items item
         ON item.id=image.cargo_item_id AND item.organization_id=image.organization_id
       JOIN transport_orders o
         ON o.id=item.order_id AND o.organization_id=item.organization_id
      WHERE image.id=? AND image.organization_id=? AND ${visibility.sql}`,
  )
    .bind(params.imageId, current.organizationId, ...visibility.values)
    .first<StoredCargoImage>();
  if (!image) throw new Response("货物图片不存在", { status: 404 });

  return storedDataUrlResponse({
    dataUrl: image.data_url,
    fileName: image.file_name,
    contentType: image.content_type,
    disposition: "inline",
  });
}
