PRAGMA foreign_keys = ON;

-- Local/demo account binding. The statement is a no-op in environments that
-- do not contain the E2E account or an active overseas destination warehouse.
INSERT OR IGNORE INTO warehouse_user_access(
  id,organization_id,warehouse_id,user_id,access_level,
  granted_by_user_id,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),w.organization_id,w.id,u.id,'manager',
       admin.id,datetime('now'),datetime('now')
FROM warehouses w
JOIN users u ON lower(u.email)='overseas@e2e.test' AND u.status='active'
LEFT JOIN users admin ON lower(admin.email)='admin@e2e.test' AND admin.status='active'
WHERE w.organization_id=(
        SELECT m.organization_id FROM memberships m
        WHERE m.user_id=u.id AND m.status='active' LIMIT 1
      )
  AND w.warehouse_role='overseas_destination'
  AND w.status='active'
ORDER BY w.code
LIMIT 1;
