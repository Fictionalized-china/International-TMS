CREATE TABLE IF NOT EXISTS membership_permission_override_archive (
  membership_id TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  effect TEXT NOT NULL,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  archive_reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_permission_override_archive_member
  ON membership_permission_override_archive(membership_id, archived_at);

INSERT INTO membership_permission_override_archive(
  membership_id,
  permission_code,
  effect,
  updated_by_user_id,
  created_at,
  updated_at,
  archived_at,
  archive_reason
)
SELECT
  membership_id,
  permission_code,
  effect,
  updated_by_user_id,
  created_at,
  updated_at,
  datetime('now'),
  'position_permission_single_source'
FROM membership_permission_overrides;

DELETE FROM membership_permission_overrides;

CREATE TRIGGER IF NOT EXISTS trg_membership_permission_overrides_no_insert
BEFORE INSERT ON membership_permission_overrides
BEGIN
  SELECT RAISE(ABORT, '账号级权限覆盖已停用，请修改岗位权限');
END;

CREATE TRIGGER IF NOT EXISTS trg_membership_permission_overrides_no_update
BEFORE UPDATE ON membership_permission_overrides
BEGIN
  SELECT RAISE(ABORT, '账号级权限覆盖已停用，请修改岗位权限');
END;
