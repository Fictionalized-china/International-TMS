UPDATE workflow_step_fields
SET is_required = 0
WHERE field_key = 'destination_address';

UPDATE workflow_instance_fields
SET is_required = 0
WHERE field_key = 'destination_address';
