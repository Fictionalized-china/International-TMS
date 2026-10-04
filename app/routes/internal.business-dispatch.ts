import { env } from "cloudflare:workers";
import type { Route } from "./+types/internal.business-dispatch";
import { refreshAutomaticDispatchTasks } from "../lib/dispatch-tasks.server";
export async function action({request}:Route.ActionArgs) {
  if(request.method!=="POST") throw new Response("Method Not Allowed",{status:405});
  if(!env.BOOTSTRAP_TOKEN || request.headers.get("Authorization")!==`Bearer ${env.BOOTSTRAP_TOKEN}`) throw new Response("Unauthorized",{status:401});
  const organizations=await env.DB.prepare("SELECT id FROM organizations WHERE status='active'").all<{id:string}>();
  const results=[];
  for(const org of organizations.results) results.push({organizationId:org.id,...await refreshAutomaticDispatchTasks(env.DB,org.id)});
  return Response.json({ok:true,results});
}
