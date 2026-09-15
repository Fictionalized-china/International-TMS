PRAGMA foreign_keys = ON;

-- The stable test account is bound to UZ-TAS-01. Older LTL demo data created a
-- second active Tashkent warehouse (UZ-TAS-90861), so a valid OUL label could
-- be rejected by the warehouse gate even though both records represented the
-- same test destination. Keep one authoritative destination without weakening
-- warehouse access checks or creating a second package barcode.

UPDATE quotations AS quotation
SET destination_warehouse_id = (
  SELECT canonical.id
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = quotation.destination_warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
)
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = quotation.destination_warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

UPDATE transport_orders AS transport_order
SET overseas_warehouse_id = (
  SELECT canonical.id
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = transport_order.overseas_warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
)
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = transport_order.overseas_warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

UPDATE order_transport_assignments AS assignment
SET destination_warehouse_id = (
  SELECT canonical.id
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = assignment.destination_warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
)
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = assignment.destination_warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

UPDATE overseas_warehouse_operations AS operation
SET warehouse_id = (
  SELECT canonical.id
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = operation.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
)
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = operation.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

UPDATE warehouse_customer_notifications AS notification
SET warehouse_id = (
  SELECT canonical.id
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = notification.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
)
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = notification.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

-- Preserve warehouse-account access while retiring the duplicate warehouse.
-- Remove only assignments that would duplicate an existing canonical binding,
-- then move any remaining legacy bindings to the canonical warehouse.
DELETE FROM warehouse_user_access AS legacy_access
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  JOIN warehouse_user_access canonical_access
    ON canonical_access.organization_id = legacy_access.organization_id
   AND canonical_access.user_id = legacy_access.user_id
   AND canonical_access.warehouse_id = canonical.id
  WHERE legacy.id = legacy_access.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

UPDATE warehouse_user_access AS access
SET warehouse_id = (
  SELECT canonical.id
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = access.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
)
WHERE EXISTS (
  SELECT 1
  FROM warehouses legacy
  JOIN warehouses canonical
    ON canonical.organization_id = legacy.organization_id
   AND canonical.code = 'UZ-TAS-01'
  WHERE legacy.id = access.warehouse_id
    AND legacy.code = 'UZ-TAS-90861'
);

UPDATE warehouses
SET status = 'disabled', updated_at = datetime('now')
WHERE code = 'UZ-TAS-90861'
  AND warehouse_role = 'overseas_destination'
  AND EXISTS (
    SELECT 1
    FROM warehouses canonical
    WHERE canonical.organization_id = warehouses.organization_id
      AND canonical.code = 'UZ-TAS-01'
      AND canonical.status = 'active'
  );
