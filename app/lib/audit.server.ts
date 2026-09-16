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

export async function writeAuditStrict(input: AuditInput): Promise<void> {
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

/**
 * Business mutations and audit persistence are not part of the same database
 * transaction at most call sites.  Do not report a completed mutation as a
 * failure merely because the follow-up audit insert failed: that encourages a
 * user retry and can duplicate the business operation.  Security-sensitive
 * flows that must fail closed can opt in to writeAuditStrict explicitly.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await writeAuditStrict(input);
  } catch (error) {
    console.error("AUDIT_WRITE_FAILED", {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
