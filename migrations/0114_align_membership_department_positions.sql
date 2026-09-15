PRAGMA foreign_keys = ON;

-- A person's department is determined by the department attached to the selected position.
-- Repair older rows where position assignment only updated position_id.
UPDATE memberships
SET department_id=(
      SELECT d.id
      FROM positions p
      JOIN departments d
        ON d.organization_id=p.organization_id AND d.code=p.department_code
      WHERE p.id=memberships.position_id
        AND p.organization_id=memberships.organization_id
        AND p.status='active'
        AND d.status='active'
      LIMIT 1
    ),
    title=COALESCE((
      SELECT p.name
      FROM positions p
      WHERE p.id=memberships.position_id
        AND p.organization_id=memberships.organization_id
      LIMIT 1
    ),title),
    updated_at=datetime('now')
WHERE position_id IS NOT NULL
  AND EXISTS(
    SELECT 1
    FROM positions p
    JOIN departments d
      ON d.organization_id=p.organization_id AND d.code=p.department_code
    WHERE p.id=memberships.position_id
      AND p.organization_id=memberships.organization_id
      AND p.status='active'
      AND d.status='active'
      AND (memberships.department_id IS NULL OR memberships.department_id<>d.id)
  );
