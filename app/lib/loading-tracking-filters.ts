export function loadingTrackingFilters(params: URLSearchParams) {
  const fields = {
    warehouse:(params.get("warehouse")||"").trim(),destination:(params.get("destination")||"").trim(),
    customer:(params.get("customer")||"").trim(),departureFrom:(params.get("departureFrom")||"").trim(),
    departureTo:(params.get("departureTo")||"").trim(),
  };
  const sql:string[] = [], values:string[] = [];
  if (fields.warehouse) {
    sql.push("AND EXISTS(SELECT 1 FROM warehouses fw WHERE fw.id=b.warehouse_id AND fw.organization_id=b.organization_id AND fw.name LIKE '%'||?||'%')");
    values.push(fields.warehouse);
  }
  if (fields.destination) {sql.push("AND b.destination_location LIKE '%'||?||'%'");values.push(fields.destination);}
  if (fields.customer) {
    sql.push(`AND EXISTS(SELECT 1 FROM transport_batch_orders fbo
      JOIN transport_orders fo ON fo.id=fbo.order_id AND fo.organization_id=fbo.organization_id
      JOIN customers fc ON fc.id=fo.customer_id AND fc.organization_id=fo.organization_id
      WHERE fbo.batch_id=b.id AND fbo.organization_id=b.organization_id AND fbo.status!='removed' AND fc.name LIKE '%'||?||'%')`);
    values.push(fields.customer);
  }
  for (const [key,operator] of [["departureFrom",">="],["departureTo","<"]] as const) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(fields[key])) {
      const at = new Date(`${fields[key]}T00:00:00Z`);
      if (Number.isFinite(at.getTime()) && at.toISOString().slice(0,10) === fields[key]) {
        if (key === "departureTo") at.setUTCDate(at.getUTCDate()+1);
        sql.push(`AND b.planned_departure_at ${operator} ?`);
        values.push(at.toISOString().slice(0,10));
      }
    }
  }
  return {fields,sql:sql.join(" "),values};
}
