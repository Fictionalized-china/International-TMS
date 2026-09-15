PRAGMA foreign_keys = ON;

-- Repair databases that applied the first modular-role migration before the
-- warehouse-account distinction was added. Protected owner/boss accounts are
-- never moved by this repair.
UPDATE memberships
SET position_id=(
      SELECT target.id FROM positions target
      WHERE target.organization_id=memberships.organization_id
        AND target.code=CASE WHEN EXISTS(
          SELECT 1 FROM warehouse_user_access wua
          JOIN warehouses w ON w.id=wua.warehouse_id AND w.organization_id=wua.organization_id
          WHERE wua.organization_id=memberships.organization_id
            AND wua.user_id=memberships.user_id
            AND w.warehouse_role='overseas_destination'
        ) THEN 'OVERSEAS_WAREHOUSE' ELSE 'WAREHOUSE' END
      LIMIT 1
    ),
    department_id=(
      SELECT d.id FROM departments d
      WHERE d.organization_id=memberships.organization_id AND d.code='OP'
      LIMIT 1
    ),
    title=CASE WHEN EXISTS(
      SELECT 1 FROM warehouse_user_access wua
      JOIN warehouses w ON w.id=wua.warehouse_id AND w.organization_id=wua.organization_id
      WHERE wua.organization_id=memberships.organization_id
        AND wua.user_id=memberships.user_id
        AND w.warehouse_role='overseas_destination'
    ) THEN '境外仓库岗' ELSE '仓库岗' END,
    updated_at=datetime('now')
WHERE EXISTS(
    SELECT 1 FROM warehouse_user_access wua
    WHERE wua.organization_id=memberships.organization_id
      AND wua.user_id=memberships.user_id
  )
  AND NOT EXISTS(
    SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id
    WHERE mr.membership_id=memberships.id AND r.code IN ('owner','boss')
  );
DELETE FROM membership_roles
WHERE membership_id IN (
    SELECT m.id FROM memberships m
    WHERE EXISTS(
      SELECT 1 FROM warehouse_user_access wua
      WHERE wua.organization_id=m.organization_id AND wua.user_id=m.user_id
    )
      AND NOT EXISTS(
        SELECT 1 FROM membership_roles protected_mr JOIN roles protected_role ON protected_role.id=protected_mr.role_id
        WHERE protected_mr.membership_id=m.id AND protected_role.code IN ('owner','boss')
      )
  )
  AND role_id IN (
    SELECT id FROM roles
    WHERE code LIKE 'pos_%' OR code IN ('warehouse_operator','overseas_warehouse_operator')
  );

INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id
FROM memberships m
JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
JOIN roles r ON r.organization_id=m.organization_id
  AND r.code=CASE p.code
    WHEN 'WAREHOUSE' THEN 'warehouse_operator'
    WHEN 'OVERSEAS_WAREHOUSE' THEN 'overseas_warehouse_operator'
  END
WHERE p.code IN ('WAREHOUSE','OVERSEAS_WAREHOUSE')
  AND EXISTS(
    SELECT 1 FROM warehouse_user_access wua
    WHERE wua.organization_id=m.organization_id AND wua.user_id=m.user_id
  );
