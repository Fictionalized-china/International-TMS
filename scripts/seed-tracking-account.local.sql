-- Local acceptance account only. Reuse the local test password without resetting any existing account.
INSERT INTO users(id,email,password_hash,display_name,phone,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),'tracking-remediation@e2e.test',password_hash,'运踪修复验收账号','13980000045','active',datetime('now'),datetime('now')
FROM users WHERE email='admin@e2e.test'
AND NOT EXISTS(SELECT 1 FROM users WHERE email='tracking-remediation@e2e.test');
INSERT INTO memberships(id,organization_id,user_id,title,status,created_at,updated_at,department_id,position_id)
SELECT lower(hex(randomblob(16))),p.organization_id,u.id,p.name,'active',datetime('now'),datetime('now'),d.id,p.id
FROM positions p JOIN users u ON u.email='tracking-remediation@e2e.test'
LEFT JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code
WHERE p.code='TRACKING' AND p.status='active'
AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=p.organization_id AND m.user_id=u.id);
INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id FROM memberships m JOIN users u ON u.id=m.user_id AND u.email='tracking-remediation@e2e.test'
JOIN positions p ON p.id=m.position_id AND p.code='TRACKING' AND p.status='active'
JOIN roles r ON r.organization_id=m.organization_id AND r.code='pos_tracking' AND r.status='active'
WHERE m.status='active';
