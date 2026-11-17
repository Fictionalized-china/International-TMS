/** A repacked inbound source and its new OUL describe the same physical stock.
 * Source links/history remain queryable, but must not inflate remaining stock. */
export function physicalWarehouseStockSql(alias="p"){
  if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))throw new Error("内部库存别名无效");
  return `${alias}.status IN ('in_stock','allocated','exception') AND ${alias}.lifecycle_status='active'
    AND NOT (${alias}.label_kind='inbound_mark' AND EXISTS(
      SELECT 1 FROM warehouse_packing_job_sources stock_source JOIN warehouse_packing_jobs stock_job
      ON stock_job.id=stock_source.packing_job_id AND stock_job.organization_id=stock_source.organization_id
      WHERE stock_source.inbound_warehouse_package_id=${alias}.id AND stock_source.organization_id=${alias}.organization_id AND stock_job.status!='cancelled'))`;
}
