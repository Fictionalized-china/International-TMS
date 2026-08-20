PRAGMA foreign_keys = ON;

ALTER TABLE workflow_definitions ADD COLUMN road_load_type TEXT NOT NULL DEFAULT 'ltl';

UPDATE workflow_definitions SET road_load_type='ftl'
WHERE code='tms-ftl-standard' OR template_family_id LIKE '%:tms-ftl-standard';
UPDATE workflow_definitions SET road_load_type='ltl'
WHERE code IN ('tms-default','tms-road-pending')
   OR template_family_id LIKE '%:tms-default'
   OR template_family_id LIKE '%:tms-road-pending';

-- The file center is a record/search surface. Files are collected and reviewed
-- in consignment, customs, tracking, warehouse and settlement modules.
UPDATE workflow_step_modules
SET is_active=0,is_required=0,updated_at=datetime('now')
WHERE module_code='documents';
