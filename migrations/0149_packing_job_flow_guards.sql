PRAGMA foreign_keys = ON;

-- 配载单尚未开始装车时允许释放订单回“已贴标待配载”。
DROP TRIGGER IF EXISTS warehouse_packing_job_status_transition_guard;
CREATE TRIGGER warehouse_packing_job_status_transition_guard
BEFORE UPDATE OF status ON warehouse_packing_jobs
WHEN NEW.status!=OLD.status AND NOT (
  (OLD.status='generated' AND NEW.status IN ('labelled','cancelled')) OR
  (OLD.status='labelled' AND NEW.status IN ('allocated','cancelled')) OR
  (OLD.status='allocated' AND NEW.status IN ('labelled','loading','cancelled')) OR
  (OLD.status='loading' AND NEW.status='dispatched')
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_status_transition_invalid');
END;

-- PZ 成员必须来自当前仓库已经完成贴标的订单。调用方先锁定包装任务，
-- 再写配载成员；并发加入另一张 PZ 时由该约束使整批事务回滚。
CREATE TRIGGER warehouse_pz_order_requires_packing_job_insert
BEFORE INSERT ON transport_batch_orders
WHEN EXISTS (
  SELECT 1 FROM transport_batches batch
  WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id
    AND batch.batch_number LIKE 'PZ-%'
) AND NOT EXISTS (
  SELECT 1
  FROM transport_batches batch
  JOIN warehouse_packing_jobs job
    ON job.organization_id=batch.organization_id
   AND job.warehouse_id=batch.warehouse_id
   AND job.order_id=NEW.order_id
  WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id
    AND job.status='allocated' AND job.transport_batch_id=NEW.batch_id
)
BEGIN
  SELECT RAISE(ABORT,'pz_order_requires_labelled_packing_job');
END;

