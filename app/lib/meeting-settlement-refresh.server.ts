import { env } from "cloudflare:workers";
import { syncCostsModuleStatus,syncOrderWorkflowSnapshot } from "./order-modules.server";
import { refreshOrderCompletionStatus } from "./order-review.server";
export async function refreshMeetingSettlement(org:string,orderId:string) {
  await syncCostsModuleStatus(org,orderId,new Date().toISOString());
  await syncOrderWorkflowSnapshot(org,orderId);
  await refreshOrderCompletionStatus(env.DB,org,[orderId],new Date().toISOString());
}
