-- Final database boundary for physical warehouse handover. Application code
-- derives business gates from each order's frozen workflow; this trigger keeps
-- the permanent dispatch invariant atomic when stale or concurrent requests
-- race the final loading -> dispatched compare-and-swap.

CREATE TRIGGER IF NOT EXISTS warehouse_dispatch_complete_integrity_guard
BEFORE UPDATE OF status ON warehouse_dispatches
WHEN OLD.status='loading' AND NEW.status='dispatched' AND (
  NOT EXISTS (
    SELECT 1
    FROM warehouse_dispatch_items item
    JOIN warehouse_packages package_row
      ON package_row.id=item.package_id
     AND package_row.organization_id=item.organization_id
    WHERE item.dispatch_id=OLD.id
      AND item.organization_id=OLD.organization_id
  )
  OR EXISTS (
    SELECT 1
    FROM warehouse_dispatch_items item
    LEFT JOIN warehouse_packages package_row
      ON package_row.id=item.package_id
     AND package_row.organization_id=item.organization_id
    WHERE item.dispatch_id=OLD.id
      AND (
        item.organization_id!=OLD.organization_id
        OR package_row.id IS NULL
        OR package_row.organization_id!=OLD.organization_id
        OR package_row.warehouse_id IS NULL
      )
  )
  OR 1!=(
    SELECT COUNT(DISTINCT package_row.warehouse_id)
    FROM warehouse_dispatch_items item
    JOIN warehouse_packages package_row
      ON package_row.id=item.package_id
     AND package_row.organization_id=item.organization_id
    WHERE item.dispatch_id=OLD.id
      AND item.organization_id=OLD.organization_id
  )
)
BEGIN
  SELECT RAISE(ABORT, '装车任务货物为空、跨组织或跨仓库，不能完成出库交接');
END;
