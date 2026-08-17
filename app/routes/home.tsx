import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/home";
import { getSessionUser } from "../lib/auth.server";
import { siteFromRequest, siteHome, siteLogin } from "../lib/site.server";

export async function loader({ request }: Route.LoaderArgs) {
  const state = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (!state?.count) throw redirect("/setup");
  const site = siteFromRequest(request);
  const session = await getSessionUser(request);
  throw redirect(session?.site === site ? siteHome(site) : siteLogin(site));
}

export default function Home() {
  return null;
}
