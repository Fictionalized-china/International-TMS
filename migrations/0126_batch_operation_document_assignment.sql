PRAGMA foreign_keys = ON;

-- 拼车配载单在审核时同时接管整批操作与单证职责；订单原负责人仅保留历史只读链路。
ALTER TABLE transport_batches ADD COLUMN document_assignee_user_id TEXT
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN responsibility_revision TEXT;

CREATE INDEX idx_transport_batches_responsibility_assignment
  ON transport_batches(
    organization_id,approval_status,operation_supervisor_user_id,
    operation_assignee_user_id,document_assignee_user_id
  );
