PRAGMA foreign_keys = ON;

-- 岗位是业务数据范围的唯一配置来源。范围只控制可见数据，不能替代
-- 工作流责任人、模块负责人或任务负责人的具体办理授权。
ALTER TABLE position_portal_settings ADD COLUMN business_data_scope TEXT NOT NULL DEFAULT 'self'
  CHECK(business_data_scope IN ('self','department','warehouse','region','company'));

UPDATE position_portal_settings
SET business_data_scope=CASE
  WHEN position_id IN (
    SELECT id FROM positions WHERE code IN ('BOSS','DEVELOPER')
  ) THEN 'company'
  WHEN position_id IN (
    SELECT id FROM positions WHERE code IN ('BUSINESS_SUPERVISOR','OPERATION_SUPERVISOR')
  ) THEN 'department'
  WHEN position_id IN (
    SELECT id FROM positions WHERE code IN ('WAREHOUSE','OVERSEAS_WAREHOUSE')
  ) THEN 'warehouse'
  WHEN position_id IN (
    SELECT id FROM positions WHERE code='OVERSEAS'
  ) THEN 'region'
  ELSE 'self'
END;

CREATE INDEX IF NOT EXISTS idx_position_portal_settings_data_scope
  ON position_portal_settings(organization_id,business_data_scope);
