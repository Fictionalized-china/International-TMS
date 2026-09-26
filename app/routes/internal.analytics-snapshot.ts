import { env } from "cloudflare:workers";
import type { Route } from "./+types/internal.analytics-snapshot";
import { generateScheduledAnalyticsSnapshots } from "../lib/analytics.server";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") throw new Response("Method Not Allowed", { status: 405 });
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.BOOTSTRAP_TOKEN || token !== env.BOOTSTRAP_TOKEN) throw new Response("Unauthorized", { status: 401 });
  return Response.json({ ok: true, ...(await generateScheduledAnalyticsSnapshots()) });
}
