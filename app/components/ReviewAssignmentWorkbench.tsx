import type { ReactNode } from "react";

export function ReviewAssignmentWorkbench({
  phase,
  approvalRecord,
  children,
}: {
  phase: "approval" | "assignment";
  approvalRecord?: { actor: string; time: string; notes: string | null };
  children: ReactNode;
}) {
  const assigning = phase === "assignment";
  return <div className="review-assignment-workbench" aria-label="审核分配办理">
    <section className="approval-section">
      <header><strong>1 · 审核结果</strong><span>{assigning ? "审核已通过，继续在下方分配任务" : "核对资料后点击“审核结果”；通过后在本页展开任务分配"}</span></header>
      {assigning ? <details className="review-assignment-record">
        <summary>审核已通过 · 查看审核记录</summary>
        {approvalRecord ? <p>{approvalRecord.actor} · {approvalRecord.time}<br />{approvalRecord.notes || "审核通过"}</p>
          : <p>审核已通过，详细记录可在右侧“历史节点与日志”查看。</p>}
      </details> : children}
    </section>
    <section className="approval-section" aria-label="任务分配">
      <header><strong>2 · 任务分配</strong><span>{assigning ? "指定责任人后确认派单" : "待审核通过后自动展开"}</span></header>
      {assigning ? <div id="review-assignment-tasks">{children}</div>
        : <p className="review-assignment-waiting">审核尚未通过，任务分配暂未开放。驳回后由原业务员补充资料。</p>}
    </section>
  </div>;
}
