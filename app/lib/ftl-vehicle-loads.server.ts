import { env } from "cloudflare:workers";

export async function ensureFtlVehicleAndLoads(input: {
  organizationId: string;
  orderId: string;
  batchId: string;
  carrierId: string;
  vehicleMasterId: string;
  driverMasterId: string;
  carrierName: string;
  vehicleType: string;
  plateNumber: string;
  driverName: string;
  driverPhone: string;
  actorUserId: string;
  now: string;
}) {
  const existingVehicle = await env.DB.prepare(
    "SELECT id FROM transport_batch_vehicles WHERE organization_id=? AND batch_id=? AND status!='cancelled' ORDER BY created_at LIMIT 1",
  )
    .bind(input.organizationId, input.batchId)
    .first<{ id: string }>();
  const vehicleId = existingVehicle?.id || crypto.randomUUID();
  if (existingVehicle?.id) {
    await env.DB.prepare(
      `UPDATE transport_batch_vehicles
       SET vehicle_type=?,plate_number=?,carrier_id=?,vehicle_master_id=?,driver_master_id=?,driver_name=?,driver_phone=?,updated_at=?
       WHERE id=? AND organization_id=?`,
    )
      .bind(
        input.vehicleType,
        input.plateNumber,
        input.carrierId,
        input.vehicleMasterId,
        input.driverMasterId,
        input.driverName,
        input.driverPhone,
        input.now,
        vehicleId,
        input.organizationId,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO transport_batch_vehicles(
        id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,vehicle_master_id,driver_master_id,
        driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'planned',?,?)`,
    )
      .bind(
        vehicleId,
        input.organizationId,
        input.batchId,
        "1",
        input.vehicleType,
        input.plateNumber,
        input.carrierId,
        input.vehicleMasterId,
        input.driverMasterId,
        input.driverName,
        input.driverPhone,
        0,
        0,
        input.now,
        input.now,
      )
      .run();
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE transport_batch_vehicles SET status='cancelled',updated_at=? WHERE organization_id=? AND batch_id=? AND id!=? AND status!='cancelled'",
    ).bind(input.now, input.organizationId, input.batchId, vehicleId),
    env.DB.prepare(
      "UPDATE transport_vehicle_loads SET vehicle_id=? WHERE organization_id=? AND batch_id=? AND vehicle_id!=?",
    ).bind(vehicleId, input.organizationId, input.batchId, vehicleId),
  ]);
  const packages = await env.DB.prepare(
    `SELECT id FROM order_cargo_packages
     WHERE organization_id=? AND order_id=? AND status!='cancelled'
     ORDER BY package_sequence,id`,
  )
    .bind(input.organizationId, input.orderId)
    .all<{ id: string }>();
  if (!packages.results.length) return;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE transport_batch_orders SET status='assigned',updated_at=? WHERE organization_id=? AND batch_id=? AND order_id=?",
    ).bind(input.now, input.organizationId, input.batchId, input.orderId),
  ];
  for (const item of packages.results) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO transport_vehicle_loads(
          id,organization_id,batch_id,vehicle_id,package_id,created_by_user_id,created_at
        ) VALUES(?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        input.batchId,
        vehicleId,
        item.id,
        input.actorUserId,
        input.now,
      ),
    );
  }
  await env.DB.batch(statements);
}
