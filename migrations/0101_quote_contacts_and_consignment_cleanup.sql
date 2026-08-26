ALTER TABLE quotations ADD COLUMN customer_contact_name TEXT;
ALTER TABLE quotations ADD COLUMN customer_contact_phone TEXT;

UPDATE quotations
SET customer_contact_name = COALESCE(
      customer_contact_name,
      (SELECT cc.name
         FROM customer_contacts cc
        WHERE cc.customer_id = quotations.customer_id
        ORDER BY cc.is_primary DESC, cc.created_at
        LIMIT 1)
    ),
    customer_contact_phone = COALESCE(
      customer_contact_phone,
      (SELECT cc.phone
         FROM customer_contacts cc
        WHERE cc.customer_id = quotations.customer_id
        ORDER BY cc.is_primary DESC, cc.created_at
        LIMIT 1)
    );

UPDATE transport_orders
SET shipper_contact = COALESCE(
      (SELECT q.customer_contact_name FROM quotations q WHERE q.id = transport_orders.quotation_id),
      shipper_contact
    ),
    shipper_phone = COALESCE(
      (SELECT q.customer_contact_phone FROM quotations q WHERE q.id = transport_orders.quotation_id),
      shipper_phone
    ),
    consignee_contact = COALESCE(
      (SELECT q.customer_contact_name FROM quotations q WHERE q.id = transport_orders.quotation_id),
      consignee_contact
    ),
    consignee_phone = COALESCE(
      (SELECT q.customer_contact_phone FROM quotations q WHERE q.id = transport_orders.quotation_id),
      consignee_phone
    ),
    requested_pickup_date = COALESCE(requested_pickup_date, created_at),
    destination_address = COALESCE(
      (SELECT w.address
         FROM quotations q
         JOIN warehouses w ON w.id = q.destination_warehouse_id
        WHERE q.id = transport_orders.quotation_id),
      destination_address
    ),
    updated_at = datetime('now')
WHERE quotation_id IS NOT NULL;

UPDATE workflow_step_fields
SET is_required = 0,
    is_active = 0,
    updated_at = datetime('now')
WHERE module_code = 'consignment'
  AND field_key IN (
    'pickup_address',
    'pickup_address_id',
    'origin_address',
    'pickup_contact',
    'pickup_phone',
    'pickup_time',
    'overseas_warehouse',
    'destination_address'
  )
  AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key = 'order_creation'
  );

UPDATE workflow_instance_fields
SET is_required = 0,
    is_active = 0
WHERE step_key = 'order_creation'
  AND module_code = 'consignment'
  AND field_key IN (
    'pickup_address',
    'pickup_address_id',
    'origin_address',
    'pickup_contact',
    'pickup_phone',
    'pickup_time',
    'overseas_warehouse',
    'destination_address'
  );

UPDATE workflow_step_fields
SET label = CASE field_key
      WHEN 'shipper_contact' THEN '客户联系人'
      WHEN 'shipper_phone' THEN '联系电话'
      ELSE label
    END,
    updated_at = datetime('now')
WHERE module_code = 'consignment'
  AND field_key IN ('shipper_contact', 'shipper_phone')
  AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key = 'order_creation'
  );

UPDATE workflow_instance_fields
SET label = CASE field_key
      WHEN 'shipper_contact' THEN '客户联系人'
      WHEN 'shipper_phone' THEN '联系电话'
      ELSE label
    END
WHERE step_key = 'order_creation'
  AND module_code = 'consignment'
  AND field_key IN ('shipper_contact', 'shipper_phone');
