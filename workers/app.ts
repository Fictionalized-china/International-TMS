import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

async function runScheduledAnalytics(env: Env) {
  const response = await requestHandler(new Request("https://scheduled.local/internal/jobs/analytics-snapshot", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.BOOTSTRAP_TOKEN}` },
  }));
  if (!response.ok) throw new Error(`Scheduled analytics snapshot failed with ${response.status}`);
  await response.arrayBuffer();
}

export default {
  async fetch(request) {
    return requestHandler(request);
  },
  scheduled(controller, env, ctx) {
    if (controller.cron === "0 18 * * *") ctx.waitUntil(runScheduledAnalytics(env));
  },
} satisfies ExportedHandler<Env>;
