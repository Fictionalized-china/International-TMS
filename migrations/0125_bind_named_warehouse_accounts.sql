PRAGMA foreign_keys = ON;

-- Warehouse test identities are named after and bound to one exact warehouse.
-- Fresh cloud environments receive the same mapping from
-- scripts/prepare-production-accounts.ts; these statements repair existing local data.
UPDATE users
SET display_name = '霍尔果斯普通仓账号', updated_at = datetime('now')
WHERE lower(email) = 'ucrstore01@e2e.test';

UPDATE users
SET display_name = '塔什干目的仓账号', updated_at = datetime('now')
WHERE lower(email) = 'overseas@e2e.test';

UPDATE memberships
SET title = '霍尔果斯普通仓账号', updated_at = datetime('now')
WHERE user_id = (SELECT id FROM users WHERE lower(email) = 'ucrstore01@e2e.test' LIMIT 1);

UPDATE memberships
SET title = '塔什干目的仓账号', updated_at = datetime('now')
WHERE user_id = (SELECT id FROM users WHERE lower(email) = 'overseas@e2e.test' LIMIT 1);

DELETE FROM warehouse_user_access
WHERE user_id = (SELECT id FROM users WHERE lower(email) = 'ucrstore01@e2e.test' LIMIT 1)
  AND warehouse_id NOT IN (
    SELECT id FROM warehouses
    WHERE organization_id = warehouse_user_access.organization_id AND code = 'HRG-01'
  );

DELETE FROM warehouse_user_access
WHERE user_id = (SELECT id FROM users WHERE lower(email) = 'overseas@e2e.test' LIMIT 1)
  AND warehouse_id NOT IN (
    SELECT id FROM warehouses
    WHERE organization_id = warehouse_user_access.organization_id AND code = 'UZ-TAS-01'
  );

INSERT OR IGNORE INTO warehouse_user_access(
  id, organization_id, warehouse_id, user_id, access_level, granted_by_user_id, created_at, updated_at
)
SELECT lower(hex(randomblob(16))), w.organization_id, w.id, u.id, 'manager', NULL, datetime('now'), datetime('now')
FROM users u
JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
JOIN warehouses w ON w.organization_id = m.organization_id AND w.code = 'HRG-01' AND w.status = 'active'
WHERE lower(u.email) = 'ucrstore01@e2e.test';

INSERT OR IGNORE INTO warehouse_user_access(
  id, organization_id, warehouse_id, user_id, access_level, granted_by_user_id, created_at, updated_at
)
SELECT lower(hex(randomblob(16))), w.organization_id, w.id, u.id, 'manager', NULL, datetime('now'), datetime('now')
FROM users u
JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
JOIN warehouses w ON w.organization_id = m.organization_id AND w.code = 'UZ-TAS-01' AND w.status = 'active'
WHERE lower(u.email) = 'overseas@e2e.test';
