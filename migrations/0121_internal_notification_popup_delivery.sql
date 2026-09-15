PRAGMA foreign_keys = ON;

-- 弹窗投递与阅读/确认分离：每个账号只自动展示一次，历史记录仍永久保留。
ALTER TABLE internal_notifications ADD COLUMN popup_shown_at TEXT;

-- 既有通知已在旧版本中具备弹窗资格，升级时视为已经展示，避免历史消息逐页重弹。
UPDATE internal_notifications
SET popup_shown_at = COALESCE(read_at, created_at)
WHERE popup_shown_at IS NULL;

CREATE INDEX idx_internal_notifications_popup
  ON internal_notifications(organization_id,user_id,popup_shown_at,created_at DESC);
