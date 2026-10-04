type ExpenseAction = "confirm" | "business_review" | "finance_review";

/** Commit the signature, confirmed fees and recovery marker together. */
export async function persistExpenseDirectionAction(input: {
  db:D1Database; organizationId:string; orderId:string; direction:"receivable"|"payable";
  action:ExpenseAction; userId:string; notes:string|null; now:string;
  refresh:() => Promise<void>;
  previousActions?:readonly ExpenseAction[];
  confirmFeesWhenAllActions?:readonly ExpenseAction[];
}) {
  const { db,organizationId,orderId,direction,action,userId,notes,now } = input;
  const revision = crypto.randomUUID();
  const columns={confirm:"confirmed",business_review:"business_reviewed",finance_review:"finance_reviewed"} as const;
  const prerequisite=(input.previousActions??[]).map(action=>` AND ${columns[action]}=1`).join("");
  const update = action === "confirm"
    ? db.prepare(`UPDATE order_expense_direction_controls
        SET confirmed=1,confirmed_by_user_id=?,confirmed_at=?,notes=COALESCE(?,notes),updated_at=?
        WHERE organization_id=? AND order_id=? AND direction=? AND confirmed=0${prerequisite}`)
        .bind(userId,now,notes,now,organizationId,orderId,direction)
    : db.prepare(`UPDATE order_expense_direction_controls
        SET ${action === "business_review" ? "business" : "finance"}_reviewed=1,
            ${action === "business_review" ? "business" : "finance"}_reviewed_by_user_id=?,
            ${action === "business_review" ? "business" : "finance"}_reviewed_at=?,
            ${action === "business_review" ? "business" : "finance"}_locked=1,
            ${action === "business_review" ? "business" : "finance"}_locked_by_user_id=?,
            ${action === "business_review" ? "business" : "finance"}_locked_at=?,notes=COALESCE(?,notes),updated_at=?
        WHERE organization_id=? AND order_id=? AND direction=? AND ${action === "business_review" ? "business" : "finance"}_reviewed=0${prerequisite}`)
        .bind(userId,now,userId,now,notes,now,organizationId,orderId,direction);
  const statements = [
    db.prepare(`INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(order_id,direction) DO NOTHING`).bind(organizationId,orderId,direction,now),
    update,
  ];
  if (input.confirmFeesWhenAllActions || action === "confirm") statements.push(db.prepare(`UPDATE business_expenses SET stage='confirmed',updated_at=?
    WHERE organization_id=? AND order_id=? AND direction=? AND stage='estimated'
      AND EXISTS(SELECT 1 FROM order_expense_direction_controls c
        WHERE c.organization_id=? AND c.order_id=? AND c.direction=? ${input.confirmFeesWhenAllActions?input.confirmFeesWhenAllActions.map(action=>`AND c.${columns[action]}=1`).join(" "):"AND c.confirmed=1"})`)
    .bind(now,organizationId,orderId,direction,organizationId,orderId,direction));
  statements.push(db.prepare(`INSERT INTO order_settlement_sync_requests(organization_id,order_id,revision,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(organization_id,order_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`)
    .bind(organizationId,orderId,revision,now));
  const results = await db.batch(statements);
  const syncPending = await retryOrderSettlementSync({db,organizationId,orderId,refresh:input.refresh});
  return { applied:Number(results[1].meta.changes)>0, syncPending };
}

export async function retryOrderSettlementSync(input: {
  db:D1Database; organizationId:string; orderId:string; refresh:() => Promise<void>;
}) {
  try {
    const pending = await input.db.prepare(`SELECT revision FROM order_settlement_sync_requests
      WHERE organization_id=? AND order_id=?`).bind(input.organizationId,input.orderId).first<{revision:string}>();
    if (!pending) return false;
    await input.refresh();
    await input.db.prepare(`DELETE FROM order_settlement_sync_requests
      WHERE organization_id=? AND order_id=? AND revision=?`)
      .bind(input.organizationId,input.orderId,pending.revision).run();
    // A concurrent signature must keep its newer recovery marker.
    return Boolean(await input.db.prepare(`SELECT revision FROM order_settlement_sync_requests
      WHERE organization_id=? AND order_id=?`).bind(input.organizationId,input.orderId).first());
  } catch (error) {
    console.error("SETTLEMENT_SYNC_PENDING",{orderId:input.orderId,error:String(error)});
    return true;
  }
}
