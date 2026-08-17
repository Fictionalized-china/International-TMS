-- Local development accounts only. Password hashes are copied from the local
-- admin account so all position accounts use the same local test password.

WITH account_seed(email, display_name) AS (
  VALUES
    ('boss@e2e.test', '老板账号'),
    ('developer@e2e.test', '开发者账号'),
    ('doc@e2e.test', '单证账号'),
    ('cs@e2e.test', '客服账号'),
    ('finance@e2e.test', '财务账号'),
    ('sales@e2e.test', '业务员账号'),
    ('overseas@e2e.test', '海外人员账号'),
    ('sales-assistant@e2e.test', '业务助理账号'),
    ('operation@e2e.test', '操作账号'),
    ('business-route@e2e.test', '商务航线账号'),
    ('booking@e2e.test', '订舱人员账号')
)
INSERT INTO users(id,email,password_hash,display_name,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),seed.email,admin.password_hash,seed.display_name,'active',datetime('now'),datetime('now')
FROM account_seed seed
CROSS JOIN (SELECT password_hash FROM users WHERE email='admin@e2e.test' LIMIT 1) admin
WHERE NOT EXISTS(SELECT 1 FROM users existing WHERE lower(existing.email)=lower(seed.email));

WITH position_accounts(email, position_code) AS (
  VALUES
    ('boss@e2e.test', 'BOSS'),
    ('developer@e2e.test', 'DEVELOPER'),
    ('doc@e2e.test', 'DOC'),
    ('cs@e2e.test', 'CS'),
    ('finance@e2e.test', 'FINANCE'),
    ('sales@e2e.test', 'SALES'),
    ('overseas@e2e.test', 'OVERSEAS'),
    ('ucrstore01@e2e.test', 'CONTAINER'),
    ('sales-assistant@e2e.test', 'SALES_ASSISTANT'),
    ('operation@e2e.test', 'OPERATION'),
    ('business-route@e2e.test', 'BUSINESS_ROUTE'),
    ('booking@e2e.test', 'BOOKING')
)
INSERT INTO memberships(id,organization_id,user_id,title,status,created_at,updated_at,department_id,position_id)
SELECT lower(hex(randomblob(16))),organization.id,user.id,position.name,'active',datetime('now'),datetime('now'),department.id,position.id
FROM position_accounts account
JOIN users user ON lower(user.email)=lower(account.email)
CROSS JOIN organizations organization
JOIN positions position ON position.organization_id=organization.id AND position.code=account.position_code
LEFT JOIN departments department ON department.organization_id=organization.id AND department.code=position.department_code
WHERE NOT EXISTS(
  SELECT 1 FROM memberships existing
  WHERE existing.organization_id=organization.id AND existing.user_id=user.id
);

WITH position_accounts(email, position_code) AS (
  VALUES
    ('boss@e2e.test', 'BOSS'),
    ('developer@e2e.test', 'DEVELOPER'),
    ('doc@e2e.test', 'DOC'),
    ('cs@e2e.test', 'CS'),
    ('finance@e2e.test', 'FINANCE'),
    ('sales@e2e.test', 'SALES'),
    ('overseas@e2e.test', 'OVERSEAS'),
    ('ucrstore01@e2e.test', 'CONTAINER'),
    ('sales-assistant@e2e.test', 'SALES_ASSISTANT'),
    ('operation@e2e.test', 'OPERATION'),
    ('business-route@e2e.test', 'BUSINESS_ROUTE'),
    ('booking@e2e.test', 'BOOKING')
)
UPDATE memberships
SET position_id=(
      SELECT position.id FROM positions position
      WHERE position.organization_id=memberships.organization_id
        AND position.code=(
          SELECT account.position_code FROM position_accounts account
          JOIN users user ON lower(user.email)=lower(account.email)
          WHERE user.id=memberships.user_id
        )
    ),
    department_id=(
      SELECT department.id
      FROM positions position
      LEFT JOIN departments department
        ON department.organization_id=position.organization_id
       AND department.code=position.department_code
      WHERE position.organization_id=memberships.organization_id
        AND position.code=(
          SELECT account.position_code FROM position_accounts account
          JOIN users user ON lower(user.email)=lower(account.email)
          WHERE user.id=memberships.user_id
        )
    ),
    title=(
      SELECT position.name FROM positions position
      WHERE position.organization_id=memberships.organization_id
        AND position.code=(
          SELECT account.position_code FROM position_accounts account
          JOIN users user ON lower(user.email)=lower(account.email)
          WHERE user.id=memberships.user_id
        )
    ),
    updated_at=datetime('now')
WHERE user_id IN (
  SELECT user.id FROM users user
  JOIN position_accounts account ON lower(account.email)=lower(user.email)
);

DELETE FROM membership_roles
WHERE membership_id IN (
  SELECT membership.id
  FROM memberships membership
  JOIN users user ON user.id=membership.user_id
  WHERE lower(user.email) IN (
    'boss@e2e.test','developer@e2e.test','doc@e2e.test','cs@e2e.test',
    'finance@e2e.test','sales@e2e.test','overseas@e2e.test','ucrstore01@e2e.test',
    'sales-assistant@e2e.test','operation@e2e.test','business-route@e2e.test','booking@e2e.test'
  )
);

WITH role_accounts(email, role_code) AS (
  VALUES
    ('boss@e2e.test', 'boss'),
    ('developer@e2e.test', 'developer'),
    ('doc@e2e.test', 'pos_doc'),
    ('cs@e2e.test', 'pos_customer_service'),
    ('finance@e2e.test', 'pos_finance'),
    ('sales@e2e.test', 'pos_sales'),
    ('overseas@e2e.test', 'pos_overseas'),
    ('ucrstore01@e2e.test', 'pos_container'),
    ('sales-assistant@e2e.test', 'pos_sales_assistant'),
    ('operation@e2e.test', 'pos_operation'),
    ('business-route@e2e.test', 'pos_business_route'),
    ('booking@e2e.test', 'pos_booking')
)
INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT membership.id,role.id
FROM role_accounts account
JOIN users user ON lower(user.email)=lower(account.email)
JOIN memberships membership ON membership.user_id=user.id
JOIN roles role ON role.organization_id=membership.organization_id AND role.code=account.role_code;
