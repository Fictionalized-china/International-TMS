PRAGMA foreign_keys = ON;

-- A whole-truck dispatch belongs to one shipment, while a PZ dispatch belongs
-- to every active order in the approved transport batch.  Keep the original
-- single-shipment guard for FTL and validate PZ jobs through batch membership.
DROP TRIGGER IF EXISTS warehouse_packing_job_dispatch_claim_guard;

CREATE TRIGGER warehouse_packing_job_dispatch_claim_guard
BEFORE UPDATE OF dispatch_id ON warehouse_packing_jobs
WHEN NEW.dispatch_id IS NOT NULL AND (
  OLD.dispatch_id IS NOT NULL OR
  OLD.status NOT IN ('labelled','allocated') OR
  NEW.status != 'allocated' OR
  NOT EXISTS (
    SELECT 1
    FROM warehouse_dispatches dispatch
    JOIN warehouse_sorting_batches sorting
      ON sorting.id = dispatch.sorting_batch_id
     AND sorting.organization_id = dispatch.organization_id
    WHERE dispatch.id = NEW.dispatch_id
      AND dispatch.organization_id = NEW.organization_id
      AND dispatch.status = 'loading'
      AND (
        (
          OLD.status = 'labelled'
          AND NEW.transport_batch_id IS NULL
          AND dispatch.transport_batch_id IS NULL
          AND sorting.shipment_id = NEW.shipment_id
        ) OR (
          OLD.status = 'allocated'
          AND NEW.transport_batch_id IS NOT NULL
          AND dispatch.transport_batch_id = NEW.transport_batch_id
          AND EXISTS (
            SELECT 1
            FROM transport_batch_orders batch_order
            WHERE batch_order.organization_id = NEW.organization_id
              AND batch_order.batch_id = NEW.transport_batch_id
              AND batch_order.order_id = NEW.order_id
              AND batch_order.status != 'removed'
          )
        )
      )
  ) OR
  NEW.outbound_package_count != (
    SELECT COUNT(*)
    FROM warehouse_packages package_row
    WHERE package_row.organization_id = NEW.organization_id
      AND package_row.warehouse_id = NEW.warehouse_id
      AND package_row.packing_job_id = NEW.id
      AND package_row.label_kind = 'oul'
      AND package_row.lifecycle_status = 'active'
      AND package_row.status = 'in_stock'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'packing_job_dispatch_claim_invalid');
END;
