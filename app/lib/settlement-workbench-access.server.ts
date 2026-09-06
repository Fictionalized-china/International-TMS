import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import { orderVisibilitySql, type OrderAccessUser } from "./order-access";
import { effectivePermissionCodes, isProtectedAccessRole, type PermissionOverride } from "./permission-blocks";
import {
  closedSettlementMultiOrderActionAccess,
  hasFullSettlementScope,
  resolveSettlementMultiOrderActionAccess,
  type SettlementLegacyFallback,
  type SettlementMultiOrderActionAccess,
  type SettlementOrderActionInput,
  type SettlementWorkbenchAction,
  type SettlementWorkbenchActor,
} from "./settlement-workbench-access";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

export type SettlementAccessSource =
  | { kind: "order_ids"; ids: readonly string[] }
  | { kind: "expense_ids"; ids: readonly string[] }
  | { kind: "reconciliation_id"; id: string };
export type FreshSettlementActorIdentity = {
  sessionId: string;
  organizationId: string;
  userId: string;
};

type FreshSettlementActorProfile = {
  membership_id: string;
  position_code: string;
  role_codes: string | null;
  inherited_codes: string | null;
  override_json: string;
};

export async function loadFreshSettlementWorkbenchActor(
  db: D1Database,
  identity: FreshSettlementActorIdentity,
  now = new Date().toISOString(),
): Promise<SettlementWorkbenchActor | null> {
  const profile = await db.prepare(
    `SELECT membership.id membership_id,position.code position_code,
       GROUP_CONCAT(DISTINCT active_role.code) role_codes,
       (
         SELECT GROUP_CONCAT(DISTINCT role_permission.permission_code)
         FROM membership_roles permission_membership_role
         JOIN roles permission_role
           ON permission_role.id=permission_membership_role.role_id
          AND permission_role.organization_id=membership.organization_id
          AND permission_role.status='active'
         JOIN role_permissions role_permission ON role_permission.role_id=permission_role.id
         WHERE permission_membership_role.membership_id=membership.id
       ) inherited_codes,
       COALESCE((
         SELECT json_group_array(json_object(
           'code',permission_override.permission_code,
           'effect',permission_override.effect
         ))
         FROM membership_permission_overrides permission_override
         WHERE permission_override.membership_id=membership.id
       ),'[]') override_json
     FROM sessions session
     JOIN users user ON user.id=session.user_id AND user.status='active'
     JOIN organizations organization
       ON organization.id=session.organization_id AND organization.status='active'
     JOIN memberships membership
       ON membership.user_id=session.user_id
      AND membership.organization_id=session.organization_id
      AND membership.status='active'
     JOIN positions position
       ON position.id=membership.position_id
      AND position.organization_id=membership.organization_id
      AND position.status='active'
     JOIN membership_roles active_membership_role
       ON active_membership_role.membership_id=membership.id
     JOIN roles active_role
       ON active_role.id=active_membership_role.role_id
      AND active_role.organization_id=membership.organization_id
      AND active_role.status='active'
     WHERE session.id=? AND session.user_id=? AND session.organization_id=?
       AND session.site='admin' AND session.expires_at>?
     GROUP BY membership.id,position.code
     LIMIT 1`,
  ).bind(
    identity.sessionId,
    identity.userId,
    identity.organizationId,
    now,
  ).first<FreshSettlementActorProfile>();
  if (!profile) return null;

  const roleCodes = splitCodes(profile.role_codes);
  if (!roleCodes.length) return null;
  let overrides: PermissionOverride[];
  try {
    const parsed = JSON.parse(profile.override_json) as unknown;
    if (!Array.isArray(parsed)) return null;
    overrides = parsed.filter((item): item is PermissionOverride => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<PermissionOverride>;
      return typeof candidate.code === "string" &&
        (candidate.effect === "allow" || candidate.effect === "deny");
    });
  } catch {
    return null;
  }

  const protectedRole = isProtectedAccessRole(roleCodes);
  const allPermissions = protectedRole
    ? (await db.prepare(
      `SELECT permission.code
       FROM permissions permission
       WHERE EXISTS(
         SELECT 1
         FROM sessions session
         JOIN users user ON user.id=session.user_id AND user.status='active'
         JOIN organizations organization ON organization.id=session.organization_id AND organization.status='active'
         JOIN memberships membership ON membership.user_id=session.user_id AND membership.organization_id=session.organization_id AND membership.status='active'
         JOIN positions position ON position.id=membership.position_id AND position.organization_id=membership.organization_id AND position.status='active'
         JOIN membership_roles active_membership_role ON active_membership_role.membership_id=membership.id
         JOIN roles active_role ON active_role.id=active_membership_role.role_id AND active_role.organization_id=membership.organization_id AND active_role.status='active'
         WHERE session.id=? AND session.user_id=? AND session.organization_id=?
           AND session.site='admin' AND session.expires_at>? AND membership.id=?
           AND active_role.code IN ('owner','boss')
       )
       ORDER BY permission.code`,
    ).bind(identity.sessionId,identity.userId,identity.organizationId,now,profile.membership_id).all<{code:string}>()).results.map((item) => item.code)
    : undefined;

  return {
    organizationId: identity.organizationId,
    userId: identity.userId,
    positionCode: profile.position_code,
    roleCodes,
    permissions: effectivePermissionCodes({
      inherited: splitCodes(profile.inherited_codes),
      overrides,
      allPermissions,
      protectedRole,
    }),
  };
}

function splitCodes(value: string | null) {
  return (value ?? "").split(",").map((code) => code.trim()).filter(Boolean);
}


export async function loadSettlementWorkbenchActionAccess(
  db: D1Database,
  input: {
    actor: SettlementWorkbenchActor;
    action: SettlementWorkbenchAction;
    source: SettlementAccessSource;
    legacyFallback: SettlementLegacyFallback;
  },
): Promise<SettlementMultiOrderActionAccess> {
  const sourceIds = input.source.kind === "reconciliation_id"
    ? normalizeIds([input.source.id])
    : normalizeIds(input.source.ids);
  if (!sourceIds.length) {
    return closedSettlementMultiOrderActionAccess(
      input.action,
      "结算操作未提供有效的关联记录",
    );
  }
  if (sourceIds.length > 100) {
    return closedSettlementMultiOrderActionAccess(
      input.action,
      "单次结算操作最多处理 100 条关联记录",
    );
  }

  const linked = await loadLinkedOrderRows(db, input.actor.organizationId, input.source, sourceIds);
  const resolvedSourceKeys = new Set(linked.map((row) => row.source_key));
  if (sourceIds.some((id) => !resolvedSourceKeys.has(id))) {
    return closedSettlementMultiOrderActionAccess(
      input.action,
      sourceFailureReason(input.source.kind),
    );
  }
  const orderIds = [...new Set(linked.map((row) => row.order_id))];
  if (!orderIds.length) {
    return closedSettlementMultiOrderActionAccess(
      input.action,
      sourceFailureReason(input.source.kind),
    );
  }

  const scope = settlementOrderScopeSql(input.actor);
  const scopeRows: Array<{
    order_id: string;
    assigned_to_actor: number;
  }> = [];
  for (const orderChunk of chunkD1Values(orderIds, scope.values.length + 1)) {
    const rows = await db.prepare(
      `SELECT o.id order_id,
         CASE WHEN (${scope.sql}) THEN 1 ELSE 0 END assigned_to_actor
       FROM transport_orders o
       WHERE o.organization_id=?
         AND o.id IN (${d1Placeholders(orderChunk.length)})
       ORDER BY o.id`,
    ).bind(...scope.values, input.actor.organizationId, ...orderChunk).all<{
      order_id: string;
      assigned_to_actor: number;
    }>();
    scopeRows.push(...rows.results);
  }
  const scopeByOrder = new Map(
    scopeRows.map((row) => [row.order_id, row.assigned_to_actor === 1]),
  );
  if (orderIds.some((orderId) => !scopeByOrder.has(orderId))) {
    return closedSettlementMultiOrderActionAccess(
      input.action,
      "部分关联订单不存在或不属于当前组织",
    );
  }

  const workflows: SettlementOrderActionInput[] = [];
  for (const orderId of orderIds) {
    workflows.push({
      orderId,
      assignedToActor: scopeByOrder.get(orderId) === true,
      workflow: await loadLockedWorkflowStageContext(
        db,
        input.actor.organizationId,
        orderId,
        "costs",
      ),
    });
  }
  return resolveSettlementMultiOrderActionAccess({
    action: input.action,
    actor: input.actor,
    legacyFallback: input.legacyFallback,
    orders: workflows,
  });
}

type LinkedOrderRow = {
  source_key: string;
  order_id: string;
};

async function loadLinkedOrderRows(
  db: D1Database,
  organizationId: string,
  source: SettlementAccessSource,
  sourceIds: string[],
) {
  if (source.kind === "order_ids") {
    const rows: LinkedOrderRow[] = [];
    for (const sourceChunk of chunkD1Values(sourceIds, 1)) {
      const result = await db.prepare(
        `SELECT o.id source_key,o.id order_id
         FROM transport_orders o
         WHERE o.organization_id=? AND o.id IN (${d1Placeholders(sourceChunk.length)})
         ORDER BY o.id`,
      ).bind(organizationId, ...sourceChunk).all<LinkedOrderRow>();
      rows.push(...result.results);
    }
    return rows;
  }
  if (source.kind === "expense_ids") {
    const rows: LinkedOrderRow[] = [];
    for (const sourceChunk of chunkD1Values(sourceIds, 1)) {
      const result = await db.prepare(
        `SELECT e.id source_key,o.id order_id
         FROM business_expenses e
         JOIN transport_orders o
           ON o.id=e.order_id AND o.organization_id=e.organization_id
         WHERE e.organization_id=? AND e.id IN (${d1Placeholders(sourceChunk.length)})
         ORDER BY e.id,o.id`,
      ).bind(organizationId, ...sourceChunk).all<LinkedOrderRow>();
      rows.push(...result.results);
    }
    return rows;
  }
  return (await db.prepare(
    `SELECT r.id source_key,o.id order_id
     FROM settlement_reconciliations r
     JOIN settlement_reconciliation_lines l
       ON l.reconciliation_id=r.id AND l.organization_id=r.organization_id
     JOIN business_expenses e
       ON e.id=l.expense_id AND e.organization_id=r.organization_id
     JOIN transport_orders o
       ON o.id=e.order_id AND o.organization_id=e.organization_id
     WHERE r.organization_id=? AND r.id=?
       AND NOT EXISTS(
         SELECT 1
         FROM settlement_reconciliation_lines invalid_line
         LEFT JOIN business_expenses invalid_expense
           ON invalid_expense.id=invalid_line.expense_id
          AND invalid_expense.organization_id=r.organization_id
         LEFT JOIN transport_orders invalid_order
           ON invalid_order.id=invalid_expense.order_id
          AND invalid_order.organization_id=r.organization_id
         WHERE invalid_line.reconciliation_id=r.id
           AND (
             invalid_line.organization_id<>r.organization_id OR
             invalid_expense.id IS NULL OR invalid_order.id IS NULL
           )
       )
     GROUP BY r.id,o.id
     ORDER BY o.id`,
  ).bind(organizationId, sourceIds[0]).all<LinkedOrderRow>()).results;
}

export function settlementOrderScopeSql(
  actor: SettlementWorkbenchActor,
  alias = "o",
) {
  if (hasFullSettlementScope(actor)) {
    return { sql: "1=1", values: [] as string[] };
  }
  const assignedActor: OrderAccessUser = {
    ...actor,
    permissions: actor.permissions.includes("order.scope.assigned")
      ? ["order.scope.assigned"]
      : [],
  };
  return orderVisibilitySql(assignedActor, alias);
}

function normalizeIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function sourceFailureReason(kind: SettlementAccessSource["kind"]) {
  if (kind === "expense_ids") return "部分费用不存在或不属于当前组织";
  if (kind === "reconciliation_id") {
    return "对账单不存在、不属于当前组织或关联订单无效";
  }
  return "部分订单不存在或不属于当前组织";
}
