PRAGMA foreign_keys = ON;

-- The old combined review/assignment node was superseded by two explicit
-- nodes: consignment approval and task assignment. Keep only the ten-node
-- canonical road workflow in built-in templates.
UPDATE workflow_steps
SET is_active=0,
    updated_at=datetime('now')
WHERE step_key='review_assignment'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  )
  AND EXISTS (
    SELECT 1 FROM workflow_steps approval
    WHERE approval.workflow_id=workflow_steps.workflow_id
      AND approval.step_key='consignment_approval'
      AND approval.is_active=1
  )
  AND EXISTS (
    SELECT 1 FROM workflow_steps assignment
    WHERE assignment.workflow_id=workflow_steps.workflow_id
      AND assignment.step_key='task_assignment'
      AND assignment.is_active=1
  );

-- Existing instances keep a frozen template version, but the obsolete
-- snapshot row must not participate in completion or blocking calculations.
DELETE FROM workflow_instance_step_states
WHERE step_key='review_assignment'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

-- Completed and cancelled orders are authoritative. Repair workflow records
-- created before completion-state synchronization was enforced.
UPDATE workflow_instance_task_states
SET status='completed',
    completed_at=COALESCE(completed_at,datetime('now')),
    updated_at=datetime('now')
WHERE instance_module_state_id IN (
  SELECT ms.id
  FROM workflow_instance_module_states ms
  JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
  JOIN workflow_instances wi ON wi.id=ss.instance_id
  JOIN transport_orders o ON o.id=wi.order_id AND o.organization_id=wi.organization_id
  WHERE o.status='completed'
);

UPDATE workflow_instance_module_states
SET status='completed',
    updated_at=datetime('now')
WHERE instance_step_state_id IN (
  SELECT ss.id
  FROM workflow_instance_step_states ss
  JOIN workflow_instances wi ON wi.id=ss.instance_id
  JOIN transport_orders o ON o.id=wi.order_id AND o.organization_id=wi.organization_id
  WHERE o.status='completed'
);

UPDATE workflow_instance_step_states
SET status='completed',
    started_at=COALESCE(started_at,datetime('now')),
    completed_at=COALESCE(completed_at,datetime('now')),
    updated_at=datetime('now')
WHERE instance_id IN (
  SELECT wi.id
  FROM workflow_instances wi
  JOIN transport_orders o ON o.id=wi.order_id AND o.organization_id=wi.organization_id
  WHERE o.status='completed'
);

UPDATE workflow_instances
SET current_step_key='completion_review',
    status='completed',
    completed_at=COALESCE(completed_at,datetime('now')),
    updated_at=datetime('now')
WHERE order_id IN (
  SELECT o.id FROM transport_orders o
  WHERE o.organization_id=workflow_instances.organization_id
    AND o.status='completed'
);

UPDATE workflow_instances
SET status='cancelled',
    updated_at=datetime('now')
WHERE order_id IN (
  SELECT o.id FROM transport_orders o
  WHERE o.organization_id=workflow_instances.organization_id
    AND o.status='cancelled'
);
