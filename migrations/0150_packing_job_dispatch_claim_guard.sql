PRAGMA foreign_keys = ON;

-- 创建装车任务时必须原子占用已经完成贴标的最终包装任务。
-- 即使两个仓库窗口同时提交，同一订单的 OUL 也只能进入一个装车任务。
CREATE TRIGGER warehouse_packing_job_dispatch_claim_guard
BEFORE UPDATE OF dispatch_id ON warehouse_packing_jobs
WHEN NEW.dispatch_id IS NOT NULL AND (
  OLD.dispatch_id IS NOT NULL OR
  OLD.status NOT IN ('labelled','allocated') OR
  NEW.status!='allocated' OR
  NOT EXISTS (
    SELECT 1
    FROM warehouse_dispatches dispatch
    JOIN warehouse_sorting_batches sorting
      ON sorting.id=dispatch.sorting_batch_id
     AND sorting.organization_id=dispatch.organization_id
    WHERE dispatch.id=NEW.dispatch_id
      AND dispatch.organization_id=NEW.organization_id
      AND dispatch.status='loading'
      AND sorting.shipment_id=NEW.shipment_id
      AND (
        (OLD.status='labelled' AND NEW.transport_batch_id IS NULL AND dispatch.transport_batch_id IS NULL) OR
        (OLD.status='allocated' AND NEW.transport_batch_id IS NOT NULL AND dispatch.transport_batch_id=NEW.transport_batch_id)
      )
  ) OR
  NEW.outbound_package_count != (
    SELECT COUNT(*)
    FROM warehouse_packages package_row
    WHERE package_row.organization_id=NEW.organization_id
      AND package_row.warehouse_id=NEW.warehouse_id
      AND package_row.packing_job_id=NEW.id
      AND package_row.label_kind='oul'
      AND package_row.lifecycle_status='active'
      AND package_row.status='in_stock'
  )
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_dispatch_claim_invalid');
END;
