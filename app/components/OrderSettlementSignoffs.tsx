import { Form } from "react-router";
import { expenseDirectionActionLabel } from "../lib/expense-control";
import type { MeetingSettlementDirection } from "../lib/meeting-settlement";

/** No money data or broad module-edit permission is needed to sign one's step. */
export function OrderSettlementSignoffs({ orderId, directions, busy, actionUrl }: {
  orderId: string;
  directions: readonly MeetingSettlementDirection[];
  busy: boolean;
  actionUrl?: string;
}) {
  return <div className="order-settlement-signoffs module-business-stack dense-module-stack">
    {directions.map(direction => {
      const actions = direction.actions.filter(action => action.active);
      const pending = actions.filter(action => action.required && !action.completed).length;
      return <section key={direction.direction} className="expense-direction-flow">
        <div className="expense-parallel-heading">
          <div><strong>{direction.direction === "receivable" ? "应收费用签核" : "应付费用签核"}</strong>
            <span>应收、应付独立办理；各方向内部遵循本单配置的签核顺序。</span></div>
          <span className={`status-pill ${pending ? "off" : "success"}`}>{pending ? `${pending} 项必办待处理` : "必办签核已完成"}</span>
        </div>
        {!actions.length && <p className="empty-state">当前工作流未启用本方向的费用签核动作。</p>}
        <div className="expense-parallel-grid">
          {actions.map(action => {
            const label = action.configuredRelease ? "确认费用（配置为无需审批链）" : expenseDirectionActionLabel(action.action, direction.direction);
            return <section key={action.action} className={`expense-parallel-card ${action.completed ? "is-complete" : "is-pending"}`}>
              <header><div><strong>{label}</strong><small>本单责任人：{action.ownerLabel}</small></div>
                <span className={`status-pill ${action.completed ? "success" : "off"}`}>{action.completed ? "已完成" : action.required ? "必办 · 待办理" : "选办"}</span></header>
              {action.completed ? <p>本项签核已保存，无需重复办理。</p>
                : action.reason ? <p>{action.reason}</p>
                : <Form method="post" action={actionUrl} className="expense-parallel-action">
                  <input type="hidden" name="intent" value="expense_direction_control" />
                  <input type="hidden" name="orderId" value={orderId} />
                  <input type="hidden" name="direction" value={direction.direction} />
                  <input type="hidden" name="action" value={action.action} />
                  <input type="hidden" name="controlAction" value={action.action} />
                  <input name="notes" aria-label={`${label}备注`} placeholder="签核备注（可选）" />
                  <button className="secondary expense-signoff-submit" disabled={busy} aria-busy={busy}>{label}</button>
                </Form>}
            </section>;
          })}
        </div>
      </section>;
    })}
  </div>;
}
