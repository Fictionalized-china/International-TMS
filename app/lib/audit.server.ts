import { env } from "cloudflare:workers";

type AuditInput = {
  request: Request;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  organizationId?: string | null;
  actorUserId?: string | null;
  outcome?: "success" | "failure";
  metadata?: Record<string, unknown>;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO audit_logs
      (id, organization_id, actor_user_id, action, resource_type, resource_id, outcome, ip_address, user_agent, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      input.organizationId ?? null,
      input.actorUserId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.outcome ?? "success",
      input.request.headers.get("CF-Connecting-IP"),
      input.request.headers.get("User-Agent"),
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    )
    .run();
}
