PRAGMA foreign_keys = ON;

-- Owner/boss permissions are immutable and always resolve to the full
-- permission catalogue. Remove stale position roles left by historical test
-- assignments so the account page also presents one unambiguous identity.
DELETE FROM membership_roles
WHERE membership_id IN (
  SELECT DISTINCT protected_mr.membership_id
  FROM membership_roles protected_mr
  JOIN roles protected_role ON protected_role.id=protected_mr.role_id
  WHERE protected_role.code IN ('owner','boss')
)
AND role_id IN (
  SELECT id FROM roles
  WHERE code LIKE 'pos_%'
     OR code IN ('developer','warehouse_operator','overseas_warehouse_operator')
);
