-- Approval only confirms the order. The operation supervisor chooses the
-- primary operator in the following dispatch action.
UPDATE order_workflow_transitions
SET requires_assignee = 0
WHERE action_code = 'approve'
  AND from_status = 'submitted'
  AND to_status = 'confirmed';
