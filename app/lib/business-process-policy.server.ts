import { businessProcessPolicyDefinitions, resolveBusinessProcessPolicy, validateBusinessProcessPolicy, type BusinessProcessPolicyKey } from "./business-process-policy";

export async function loadBusinessProcessPolicy(organizationId: string, db?: D1Database) {
  const database=db??(await import("cloudflare:workers")).env.DB;
  const rows = await database.prepare("SELECT policy_key,policy_value FROM business_process_policies WHERE organization_id=?").bind(organizationId).all<{ policy_key: string; policy_value: string }>();
  return resolveBusinessProcessPolicy(rows.results);
}

export async function saveBusinessProcessPolicy(input: { organizationId: string; userId: string; values: Partial<Record<BusinessProcessPolicyKey, unknown>>; additionalStatements?: D1PreparedStatement[] }, database?: D1Database) {
  const db=database??(await import("cloudflare:workers")).env.DB;
  const values = validateBusinessProcessPolicy(input.values);
  const positions = await db.prepare("SELECT code FROM positions WHERE organization_id=? AND status='active'").bind(input.organizationId).all<{ code: string }>();
  const active = new Set(positions.results.map(p => p.code));
  for (const definition of businessProcessPolicyDefinitions) {
    if (definition.kind === "positions" && values[definition.key]?.split(",").some(code => !active.has(code))) throw new Error(`${definition.label}包含已停用或不存在的岗位`);
  }
  const now = new Date().toISOString();
  await db.batch([...Object.entries(values).flatMap(([key, value]) => [
    db.prepare(`INSERT INTO business_process_policy_history(id,organization_id,policy_key,old_value,new_value,actor_user_id,created_at)
      SELECT ?,?,?,(SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key=?),?,?,?`)
      .bind(crypto.randomUUID(), input.organizationId, key, input.organizationId, key, value, input.userId, now),
    db.prepare(`INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_by_user_id,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(organization_id,policy_key) DO UPDATE SET policy_value=excluded.policy_value,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`)
      .bind(input.organizationId, key, value, input.userId, now),
  ]),...(input.additionalStatements ?? [])]);
}
