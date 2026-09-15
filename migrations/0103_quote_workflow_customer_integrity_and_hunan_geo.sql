PRAGMA foreign_keys = ON;

-- A quotation owns the workflow version that will be instantiated after the
-- customer accepts it. Historical quotations remain nullable and continue to
-- use the compatible default workflow.
ALTER TABLE quotations ADD COLUMN workflow_definition_id TEXT
  REFERENCES workflow_definitions(id) ON DELETE SET NULL;

CREATE INDEX idx_quotations_workflow_definition
  ON quotations(organization_id, workflow_definition_id, lifecycle_status);

-- Normalize legacy duplicate primaries before enforcing one primary contact
-- per customer. The most recently updated primary remains authoritative.
WITH ranked_primary_contacts AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY customer_id
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS row_number
  FROM customer_contacts
  WHERE is_primary=1
)
UPDATE customer_contacts
SET is_primary=0
WHERE id IN (
  SELECT id FROM ranked_primary_contacts WHERE row_number > 1
);

CREATE UNIQUE INDEX idx_customer_contacts_one_primary
  ON customer_contacts(customer_id)
  WHERE is_primary=1;

-- Complete the minimum China geography needed by the tested Changsha route.
INSERT INTO reference_data(
  id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),o.id,'province','CN-HN','湖南省','Hunan','CN',30,'active',datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM reference_data r
  WHERE r.organization_id=o.id AND r.category='province' AND r.code='CN-HN'
);

INSERT INTO reference_data(
  id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),o.id,'city','CN-HN-CSX','长沙市','Changsha','CN-HN',10,'active',datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM reference_data r
  WHERE r.organization_id=o.id AND r.category='city' AND r.code='CN-HN-CSX'
);
