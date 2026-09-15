-- Accepted quotations historically created one planned package containing N
-- pieces. The quotation's piece count represents N physical packages, so only
-- untouched, automatically generated cargo may be repaired here. Any receipt,
-- warehouse package, loading reference, non-planned package state, or manual
-- cargo change keeps the order outside this migration.

CREATE TABLE IF NOT EXISTS migration_0134_quote_cargo_targets (
  cargo_item_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  package_count INTEGER NOT NULL,
  gross_weight_total REAL NOT NULL,
  net_weight_total REAL NOT NULL,
  volume_total REAL NOT NULL,
  package_created_at TEXT NOT NULL
);

DELETE FROM migration_0134_quote_cargo_targets;

INSERT INTO migration_0134_quote_cargo_targets(
  cargo_item_id,organization_id,order_id,order_number,package_count,
  gross_weight_total,net_weight_total,volume_total,package_created_at
)
SELECT
  item.id,item.organization_id,item.order_id,orders.order_number,
  item.pieces_per_package,item.gross_weight_per_package_kg,
  item.net_weight_per_package_kg,item.volume_per_package_cbm,
  packages.created_at
FROM order_cargo_items item
JOIN transport_orders orders
  ON orders.id=item.order_id
 AND orders.organization_id=item.organization_id
JOIN quotations quote
  ON quote.id=orders.quotation_id
 AND quote.organization_id=orders.organization_id
JOIN order_cargo_packages packages
  ON packages.cargo_item_id=item.id
 AND packages.organization_id=item.organization_id
 AND packages.order_id=item.order_id
WHERE quote.status='accepted'
  AND quote.lifecycle_status='accepted'
  AND item.notes='由已接受报价自动生成'
  AND item.line_no=1
  AND item.package_type='other'
  AND item.package_count=1
  AND item.pieces_per_package>1
  AND item.pieces_per_package<=500
  AND orders.pieces=item.pieces_per_package
  AND quote.pieces=item.pieces_per_package
  AND ABS(orders.gross_weight_kg-quote.gross_weight_kg)<0.000001
  AND ABS(orders.volume_cbm-quote.volume_cbm)<0.000001
  AND ABS(item.gross_weight_per_package_kg-quote.gross_weight_kg)<0.000001
  AND ABS(item.volume_per_package_cbm-quote.volume_cbm)<0.000001
  AND packages.package_sequence=1
  AND packages.package_code=orders.order_number||'-P001'
  AND packages.status='planned'
  AND EXISTS (
    SELECT 1 FROM order_workflow_history history
    WHERE history.organization_id=item.organization_id
      AND history.order_id=item.order_id
      AND history.action_code='quote_accepted_auto_create'
  )
  AND 1=(
    SELECT COUNT(*) FROM order_cargo_items siblings
    WHERE siblings.organization_id=item.organization_id
      AND siblings.order_id=item.order_id
  )
  AND 1=(
    SELECT COUNT(*) FROM order_cargo_packages planned
    WHERE planned.organization_id=item.organization_id
      AND planned.order_id=item.order_id
      AND planned.cargo_item_id=item.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_receipt_items receipt_item
    WHERE receipt_item.organization_id=item.organization_id
      AND receipt_item.order_id=item.order_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM warehouse_packages warehouse_package
    JOIN shipments shipment
      ON shipment.id=warehouse_package.shipment_id
     AND shipment.organization_id=warehouse_package.organization_id
    WHERE warehouse_package.organization_id=item.organization_id
      AND shipment.order_id=item.order_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM transport_vehicle_loads vehicle_load
    JOIN order_cargo_packages loaded_package
      ON loaded_package.id=vehicle_load.package_id
     AND loaded_package.organization_id=vehicle_load.organization_id
    WHERE loaded_package.organization_id=item.organization_id
      AND loaded_package.order_id=item.order_id
  );

DELETE FROM order_cargo_packages
WHERE cargo_item_id IN (
  SELECT cargo_item_id FROM migration_0134_quote_cargo_targets
);

UPDATE order_cargo_items
SET package_count=(
      SELECT target.package_count
      FROM migration_0134_quote_cargo_targets target
      WHERE target.cargo_item_id=order_cargo_items.id
    ),
    pieces_per_package=1,
    gross_weight_per_package_kg=gross_weight_per_package_kg/pieces_per_package,
    net_weight_per_package_kg=net_weight_per_package_kg/pieces_per_package,
    volume_per_package_cbm=volume_per_package_cbm/pieces_per_package,
    updated_at=datetime('now')
WHERE id IN (
  SELECT cargo_item_id FROM migration_0134_quote_cargo_targets
);

WITH RECURSIVE package_sequence(cargo_item_id,sequence_no,package_count) AS (
  SELECT cargo_item_id,1,package_count
  FROM migration_0134_quote_cargo_targets
  UNION ALL
  SELECT cargo_item_id,sequence_no+1,package_count
  FROM package_sequence
  WHERE sequence_no<package_count
)
INSERT INTO order_cargo_packages(
  id,organization_id,order_id,cargo_item_id,package_code,
  package_sequence,status,created_at
)
SELECT
  lower(hex(randomblob(16))),target.organization_id,target.order_id,
  target.cargo_item_id,target.order_number||'-P'||printf('%03d',sequence.sequence_no),
  sequence.sequence_no,'planned',target.package_created_at
FROM package_sequence sequence
JOIN migration_0134_quote_cargo_targets target
  ON target.cargo_item_id=sequence.cargo_item_id;

DROP TABLE migration_0134_quote_cargo_targets;
