import { env } from "cloudflare:workers";
import type { Route } from "./+types/internal.business-dispatch";
import { refreshAutomaticDispatchTasks } from "../lib/dispatch-tasks.server";
import { generateScheduledHrReports } from "../lib/hr-reports.server";
import { refreshTrackingAlerts } from '../lib/tracking-alerts.server';
import {tryPhysicalSyncJob} from "../lib/physical-operation-sync.server";
export async function action({request}:Route.ActionArgs) {
  if(request.method!=="POST") throw new Response("Method Not Allowed",{status:405});
  if(!env.BOOTSTRAP_TOKEN || request.headers.get("Authorization")!==`Bearer ${env.BOOTSTRAP_TOKEN}`) throw new Response("Unauthorized",{status:401});
  const organizations=await env.DB.prepare("SELECT id FROM organizations WHERE status='active'").all<{id:string}>();
  const results=[];
  for(const org of organizations.results){
    const pending=await env.DB.prepare("SELECT id FROM physical_operation_sync_jobs WHERE organization_id=? AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 5").bind(org.id,new Date().toISOString()).all<{id:string}>();
    let synchronized=0;for(const job of pending.results)if(!(await tryPhysicalSyncJob(env.DB,org.id,job.id)).syncPending)synchronized++;
    results.push({organizationId:org.id,...await refreshAutomaticDispatchTasks(env.DB,org.id),hrReports:await generateScheduledHrReports(env.DB,org.id),trackingAlerts:await refreshTrackingAlerts(env.DB,org.id),physicalSync:{attempted:pending.results.length,synchronized}});
  }
  return Response.json({ok:true,results});
}
