import { env } from "cloudflare:workers";
import {
  operationalRuleDefinitions,
  normalizeOperationalRuleValue,
  resolveOperationalRuleValues,
  type OperationalRuleCode,
} from "./operational-rules";

export async function loadOperationalRules(organizationId: string) {
  const result = await env.DB.prepare(
    `SELECT rule_code,numeric_value
       FROM operational_rule_configs
      WHERE organization_id=?`,
  ).bind(organizationId).all<{ rule_code: string; numeric_value: number | string | null }>();
  return resolveOperationalRuleValues(result.results);
}

export async function saveOperationalRules(input: {
  organizationId: string;
  actorUserId: string;
  values: Partial<Record<OperationalRuleCode, unknown>>;
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  const statements = operationalRuleDefinitions
    .filter((definition) => Object.prototype.hasOwnProperty.call(input.values, definition.code))
    .map((definition) => env.DB.prepare(
      `INSERT INTO operational_rule_configs(
         id,organization_id,rule_code,numeric_value,updated_by_user_id,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,rule_code) DO UPDATE SET
         numeric_value=excluded.numeric_value,
         updated_by_user_id=excluded.updated_by_user_id,
         updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      definition.code,
      normalizeOperationalRuleValue(definition.code, input.values[definition.code]),
      input.actorUserId,
      now,
      now,
    ));
  if (statements.length) await env.DB.batch(statements);
}
