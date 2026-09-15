import { env } from "cloudflare:workers";

import type { Route } from "./+types/admin.customer-contract-download";
import { requireSessionUser } from "../lib/auth.server";
import { storedDataUrlResponse } from "../lib/stored-file-response.server";

type ContractFile = {
  file_name: string;
  content_type: string;
  data_url: string;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "customer.view");
  const contract = await env.DB.prepare(
    "SELECT file_name,content_type,data_url FROM customer_contracts WHERE id=? AND organization_id=?",
  )
    .bind(params.contractId, current.organizationId)
    .first<ContractFile>();
  if (!contract) throw new Response("客户合同不存在", { status: 404 });

  return storedDataUrlResponse({
    dataUrl: contract.data_url,
    fileName: contract.file_name,
    contentType: contract.content_type,
  });
}
