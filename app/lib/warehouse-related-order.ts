/** Read-only physical relationship; never grants a warehouse mutation. */
export function warehouseRelatedOrderSql(warehouseId: string, warehouseRole: string) {
  return {
    sql: `(
      EXISTS(SELECT 1 FROM shipments related_s JOIN warehouse_packages related_p ON related_p.shipment_id=related_s.id AND related_p.organization_id=related_s.organization_id
        WHERE related_s.order_id=o.id AND related_s.organization_id=o.organization_id AND related_p.warehouse_id=?)
      OR EXISTS(SELECT 1 FROM shipments related_s JOIN warehouse_receipts related_r ON related_r.shipment_id=related_s.id AND related_r.organization_id=related_s.organization_id
        WHERE related_s.order_id=o.id AND related_s.organization_id=o.organization_id AND related_r.warehouse_id=? AND related_r.status!='cancelled')
      OR EXISTS(SELECT 1 FROM order_transport_assignments related_a WHERE related_a.organization_id=o.organization_id AND related_a.order_id=o.id AND related_a.destination_warehouse_id=?
        AND related_a.id=(SELECT latest_a.id FROM order_transport_assignments latest_a WHERE latest_a.organization_id=o.organization_id AND latest_a.order_id=o.id AND latest_a.leg_type='first_mile' AND latest_a.status!='cancelled' ORDER BY latest_a.updated_at DESC,latest_a.created_at DESC,latest_a.id DESC LIMIT 1))
      OR EXISTS(SELECT 1 FROM transport_batches related_b WHERE related_b.organization_id=o.organization_id AND related_b.warehouse_id=? AND related_b.status!='cancelled'
        AND (related_b.order_id=o.id OR EXISTS(SELECT 1 FROM transport_batch_orders related_bo WHERE related_bo.organization_id=related_b.organization_id AND related_bo.batch_id=related_b.id AND related_bo.order_id=o.id AND related_bo.status!='removed')))
      OR (?='overseas_destination' AND o.overseas_warehouse_id=?)
    )`,
    values: [warehouseId, warehouseId, warehouseId, warehouseId, warehouseRole, warehouseId],
  };
}
