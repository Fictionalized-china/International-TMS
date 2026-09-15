PRAGMA foreign_keys = ON;

-- Protected owner/boss accounts always stay on the boss position. Their role
-- grants are immutable in application code and are not touched here.
UPDATE memberships
SET position_id=(
      SELECT p.id FROM positions p
      WHERE p.organization_id=memberships.organization_id AND p.code='BOSS'
      LIMIT 1
    ),
    department_id=(
      SELECT d.id FROM departments d
      WHERE d.organization_id=memberships.organization_id AND d.code='ZJB'
      LIMIT 1
    ),
    title='老板',
    updated_at=datetime('now')
WHERE EXISTS(
  SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id
  WHERE mr.membership_id=memberships.id AND r.code IN ('owner','boss')
);
