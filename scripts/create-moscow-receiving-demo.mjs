// One isolated production demonstration order. Default: full transaction + rollback.
// Run from the deployed release via stdin so its existing connection helper is used.
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createMysqlRuntimeConnection } = await import(pathToFileURL(resolve('scripts/mysql-runtime-connection.mjs')).href);

const apply = process.argv.includes('--apply');
const org = '33de8358-0f85-4526-8ab8-9f94ed2aafcc';
const sourceId = '942ca8b3-b8a3-4cbe-97bb-401a6ec17800';
const destination = '20a0ff17-2ddd-4cc7-80f7-9a187bd66553';
const number = 'DEMO-MOS-20261104-01';
const batchNumber = 'PZ-DEMO-MOS-20261104-01';
const barcode = 'OUL-DEMO-MOS-20261104-01-001';
const note = '演示预置数据，非真实业务；仅用于莫斯科境外仓收货演示。前置环节为演示快照，未实际办理审批或资金。';
const now = new Date().toISOString();
const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const db = await createMysqlRuntimeConnection();
const groups = new Map();
const ids = new Map();
const counts = {};
const generated = new Map();
const rows = async (sql, values = []) => (await db.query(sql, values))[0];
const one = async (sql, values = []) => {
  const result = await rows(sql, values);
  if (result.length !== 1) throw new Error(`Expected one prerequisite, found ${result.length}: ${sql}`);
  return result[0];
};
function collect(table, data) {
  for (const row of data) if (row.id) ids.set(row.id, randomUUID());
  groups.set(table, data);
  return data;
}
function clone(row, changes = {}) {
  const value = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_px_')).map(([key, val]) => [key, ids.get(val) ?? val]));
  if ('created_at' in value) value.created_at = at(360);
  if ('updated_at' in value) value.updated_at = now;
  return { ...value, ...changes };
}
async function insert(table, value) {
  if (!generated.has(table)) generated.set(table, new Set((await rows(`SHOW COLUMNS FROM \`${table}\``)).filter(c => /GENERATED/.test(c.Extra)).map(c => c.Field)));
  const keys = Object.keys(value).filter(key => !generated.get(table).has(key));
  await db.execute(`INSERT INTO \`${table}\` (${keys.map(key => `\`${key}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => value[key]));
  counts[table] = (counts[table] ?? 0) + 1;
}
async function coreDigest() {
  const result = {};
  for (const table of ['transport_orders', 'settlement_cash_transactions', 'settlement_cash_allocations']) {
    const data = await rows(`SELECT * FROM \`${table}\` ORDER BY id`);
    result[table] = { count: data.length, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  }
  return result;
}
let begun = false;
try {
  const existing = await rows('SELECT id,order_number,status FROM transport_orders WHERE organization_id=? AND order_number=?', [org, number]);
  if (existing.length) {
    console.log(JSON.stringify({ alreadyExists: true, order: existing[0], message: 'No reset or duplicate creation performed.' }));
  } else {
    const source = await one('SELECT * FROM transport_orders WHERE organization_id=? AND id=?', [org, sourceId]);
    const warehouse = await one("SELECT * FROM warehouses WHERE organization_id=? AND id=? AND status='active' AND warehouse_role='overseas_destination'", [org, destination]);
    const actor = await one("SELECT * FROM users WHERE email='admin@e2e.test' AND status='active'");
    const warehouseActor = await one("SELECT u.id,u.email FROM users u JOIN warehouse_user_access a ON a.user_id=u.id AND a.organization_id=? WHERE a.warehouse_id=? AND u.status='active' AND a.access_level IN ('operator','manager')", [org, destination]);
    collect('transport_orders', [source]);
    const shipment = collect('shipments', await rows('SELECT * FROM shipments WHERE organization_id=? AND order_id=?', [org, sourceId]));
    if (shipment.length !== 1) throw new Error('Demo template must have exactly one shipment');
    const workflow = collect('workflow_instances', [await one('SELECT * FROM workflow_instances WHERE id=? AND organization_id=? AND order_id=?', [source.workflow_instance_id, org, sourceId])])[0];
    const steps = collect('workflow_instance_step_states', await rows('SELECT * FROM workflow_instance_step_states WHERE instance_id=? ORDER BY sort_order', [workflow.id]));
    const current = steps.find(s => s.step_key === 'outbound_transport');
    if (!current || !steps.find(s => s.step_key === 'overseas_pickup')) throw new Error('Frozen workflow has no appropriate transport/warehouse placement');
    const modules = collect('workflow_instance_module_states', await rows('SELECT ms.* FROM workflow_instance_module_states ms JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id WHERE ss.instance_id=?', [workflow.id]));
    const tasks = collect('workflow_instance_task_states', await rows('SELECT t.* FROM workflow_instance_task_states t JOIN workflow_instance_module_states ms ON ms.id=t.instance_module_state_id JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id WHERE ss.instance_id=?', [workflow.id]));
    collect('workflow_instance_fields', await rows('SELECT * FROM workflow_instance_fields WHERE instance_id=?', [workflow.id]));
    collect('order_module_instances', await rows('SELECT * FROM order_module_instances WHERE organization_id=? AND order_id=?', [org, sourceId]));
    const cargo = collect('order_cargo_items', await rows('SELECT * FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no', [org, sourceId]));
    const marks = collect('order_cargo_packages', await rows('SELECT * FROM order_cargo_packages WHERE organization_id=? AND order_id=? AND is_active=1 ORDER BY package_sequence', [org, sourceId]));
    if (cargo.length !== 2 || marks.length !== 2) throw new Error('Unexpected cargo template; refusing an ambiguous copy');
    const member = collect('transport_batch_orders', await rows("SELECT * FROM transport_batch_orders WHERE organization_id=? AND order_id=? AND status!='removed'", [org, sourceId]));
    if (member.length !== 1) throw new Error('Template has multiple active transport batches');
    const batch = collect('transport_batches', [await one('SELECT * FROM transport_batches WHERE organization_id=? AND id=?', [org, member[0].batch_id])])[0];
    const dispatch = collect('warehouse_dispatches', [await one("SELECT * FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='dispatched'", [org, batch.id])])[0];
    const sorting = collect('warehouse_sorting_batches', [await one('SELECT * FROM warehouse_sorting_batches WHERE organization_id=? AND id=?', [org, dispatch.sorting_batch_id])])[0];
    const packJob = collect('warehouse_packing_jobs', [await one("SELECT * FROM warehouse_packing_jobs WHERE organization_id=? AND order_id=? AND status='dispatched'", [org, sourceId])])[0];
    const packages = collect('warehouse_packages', await rows('SELECT * FROM warehouse_packages WHERE organization_id=? AND shipment_id=?', [org, shipment[0].id]));
    const inbound = packages.filter(p => p.label_kind === 'inbound_mark');
    const oul = packages.filter(p => p.label_kind === 'oul');
    if (inbound.length !== 2 || oul.length !== 1) throw new Error('Unexpected physical package template');
    const receipt = collect('warehouse_receipts', [await one('SELECT * FROM warehouse_receipts WHERE organization_id=? AND id=?', [org, inbound[0].receipt_id])])[0];
    collect('order_customs_records', await rows('SELECT * FROM order_customs_records WHERE organization_id=? AND order_id=?', [org, sourceId]));
    collect('order_customs_declarations', await rows('SELECT * FROM order_customs_declarations WHERE organization_id=? AND order_id=?', [org, sourceId]));
    const orderId = ids.get(sourceId), shipmentId = ids.get(shipment[0].id), batchId = ids.get(batch.id), dispatchId = ids.get(dispatch.id);
    const oldDigest = await coreDigest();
    await db.beginTransaction(); begun = true;
    await insert('transport_orders', clone(source, { order_number: number, quotation_id: null, workflow_instance_id: null, customer_reference: number+' 演示订单', status: 'in_execution', current_step_code: 'module:tracking', current_step_name: '出境运输 · 待莫斯科境外仓收货', current_assignee_user_id: warehouseActor.id, completion_status: 'in_progress', business_completed_at: null, settlement_completed_at: null, special_instructions: note, route_notes: note, cargo_description: '【演示】五金配件 A、B', pieces: 2, gross_weight_kg: 120, volume_cbm: 0.24, planned_inbound_package_count: 2, created_by_user_id: actor.id, created_at: at(360), order_date: now.slice(0,10), workflow_updated_at: now, is_overdue: 0, exception_status: 'normal', confirmed_at: at(350), destination_country: '俄罗斯', destination_state: '莫斯科', destination_city: '莫斯科', destination_address: warehouse.address || '莫斯科试验仓', overseas_warehouse_id: destination, requested_delivery_date: null, inbound_package_locked_at: at(240) }));
    await insert('shipments', clone(shipment[0], { shipment_number: 'SHP-'+number, master_tracking_number: null, status: 'in_transit', current_location: '莫斯科境外仓待收货（演示）', actual_delivery_at: null, signed_by: null, exception_reason: null, actual_pickup_at: at(300), estimated_delivery_at: new Date(Date.now()+1800000).toISOString() }));
    await insert('workflow_instances', clone(workflow, { quotation_id: null, shipment_id: shipmentId, invoice_id: null, current_step_key: current.step_key, status: 'active', started_at: at(360), completed_at: null }));
    await db.execute('UPDATE transport_orders SET workflow_instance_id=? WHERE organization_id=? AND id=? AND order_number=?', [ids.get(workflow.id), org, orderId, number]);
    for (const step of steps) await insert('workflow_instance_step_states', clone(step, { status: step.sort_order < current.sort_order ? 'completed' : step.id === current.id ? 'active' : 'pending', started_at: step.sort_order <= current.sort_order ? at(180) : null, completed_at: step.sort_order < current.sort_order ? at(150) : null }));
    for (const module of modules) {
      const step = steps.find(s => s.id === module.instance_step_state_id);
      await insert('workflow_instance_module_states', clone(module, { status: step.sort_order < current.sort_order ? 'completed' : step.id === current.id ? 'active' : 'pending' }));
    }
    for (const task of tasks) {
      const module = modules.find(m => m.id === task.instance_module_state_id), step = steps.find(s => s.id === module.instance_step_state_id);
      await insert('workflow_instance_task_states', clone(task, { status: step.sort_order < current.sort_order ? 'completed' : step.id === current.id ? 'active' : 'pending', completed_at: step.sort_order < current.sort_order ? at(150) : null, completed_by_user_id: step.sort_order < current.sort_order ? actor.id : null, assignee_user_id: module.module_code === 'overseas_warehouse' ? warehouseActor.id : task.assignee_user_id, instructions: note }));
    }
    for (const field of groups.get('workflow_instance_fields')) await insert('workflow_instance_fields', clone(field));
    for (const module of groups.get('order_module_instances')) {
      const changes = { blocking_reason: null };
      if (module.module_code === 'overseas_warehouse') Object.assign(changes, { status: 'not_started', current_step_code: 'waiting_arrival', current_step_name: '等待莫斯科境外仓扫码收货', progress_percent: 0, started_at: null, completed_at: null, assignee_user_id: warehouseActor.id });
      if (module.module_code === 'tracking') Object.assign(changes, { status: 'in_progress', current_step_code: 'customs_cleared', current_step_name: '目的地清关已完成，待境外仓收货', progress_percent: 80, completed_at: null });
      if (['costs','review'].includes(module.module_code)) Object.assign(changes, { status: 'not_started', current_step_code: 'waiting', current_step_name: '前序环节完成后办理', progress_percent: 0, started_at: null, completed_at: null });
      await insert('order_module_instances', clone(module, changes));
    }
    for (let index=0;index<cargo.length;index++) await insert('order_cargo_items', clone(cargo[index], { cargo_name_cn: `【演示】五金配件 ${index ? 'B' : 'A'}`, package_count: 1, gross_weight_per_package_kg: index ? 70 : 50, net_weight_per_package_kg: index ? 70 : 50, length_cm: 60, width_cm: 40, height_cm: 50, volume_per_package_cbm: 0.12, notes: note, declared_value: 0 }));
    for (let index=0;index<marks.length;index++) await insert('order_cargo_packages', clone(marks[index], { package_code: `${number}-IN-${String(index+1).padStart(3,'0')}`, package_sequence: index+1, status: 'received', received_at: at(240), received_warehouse_id: batch.warehouse_id, received_location_id: receipt.location_id, received_by_user_id: actor.id }));
    await insert('transport_batches', clone(batch, { order_id: orderId, batch_number: batchNumber, batch_name: '【演示】霍尔果斯 → 莫斯科境外仓', destination_location: warehouse.name, route_key: `${batch.warehouse_id}|${destination}|俄罗斯|莫斯科|莫斯科`, status: 'departed', road_status: 'outbound_in_transit', actual_departure_at: at(120), actual_arrival_at: null, planned_departure_at: at(130), planned_arrival_at: new Date(Date.now()+1800000).toISOString(), notes: note, approval_notes: note, created_by_user_id: actor.id, responsibility_revision: randomUUID() }));
    await insert('warehouse_receipts', clone(receipt, { receipt_number: 'IN-'+number, total_packages: 2, total_pieces: 2, total_weight_kg: 120, total_volume_cbm: 0.24, notes: note, evidence_note: note, cargo_complete: 1, has_exception: 0, exception_notes: null, received_by_user_id: actor.id, received_at: at(240) }));
    await insert('warehouse_sorting_batches', clone(sorting, { batch_number: 'SORT-'+number, shipment_id: shipmentId, status: 'verified', notes: note, created_by_user_id: actor.id, verified_by_user_id: actor.id, verified_at: at(230) }));
    await insert('warehouse_dispatches', clone(dispatch, { dispatch_number: 'OUT-'+number, shipment_id: shipmentId, destination: warehouse.name, status: 'loading', notes: note, created_by_user_id: actor.id, dispatched_by_user_id: actor.id, dispatched_at: at(130) }));
    await insert('warehouse_packing_jobs', clone(packJob, { status: 'generated', dispatch_id: null, transport_batch_id: null, source_package_count: 2, outbound_package_count: 1, total_weight_kg: 120, total_volume_cbm: 0.24, notes: note, labeling_confirmed_at: at(180), labeling_confirmed_by_user_id: actor.id, created_by_user_id: actor.id }));
    for (let index=0;index<inbound.length;index++) await insert('warehouse_packages', clone(inbound[index], { barcode: `${number}-IN-${String(index+1).padStart(3,'0')}`, package_number: `${number}-IN-${String(index+1).padStart(3,'0')}`, status: 'in_stock', lifecycle_status: 'active', weight_kg: index ? 70 : 50, volume_cbm: 0.12, length_cm: 60, width_cm: 40, height_cm: 50, warehouse_id: batch.warehouse_id, location_id: receipt.location_id, receipt_id: ids.get(receipt.id), notes: note, packing_batch_id: null, packing_job_id: null }));
    await insert('warehouse_packages', clone(oul[0], { receipt_id: ids.get(receipt.id), warehouse_id: batch.warehouse_id, location_id: receipt.location_id, barcode, package_number: barcode, pieces: 2, weight_kg: 120, volume_cbm: 0.24, length_cm: 80, width_cm: 60, height_cm: 50, status: 'in_stock', lifecycle_status: 'active', notes: note, packing_batch_id: null, signed_at: null }));
    for (const input of inbound) await insert('warehouse_packing_job_sources', { id: randomUUID(), organization_id: org, packing_job_id: ids.get(packJob.id), inbound_warehouse_package_id: ids.get(input.id), created_at: at(180) });
    // Respect the same packing/claim/dispatch triggers as normal business writes.
    await db.execute("UPDATE warehouse_packing_jobs SET status='labelled' WHERE id=? AND organization_id=?", [ids.get(packJob.id),org]);
    await db.execute("UPDATE warehouse_packing_jobs SET status='allocated',transport_batch_id=? WHERE id=? AND organization_id=?", [batchId,ids.get(packJob.id),org]);
    await insert('transport_batch_orders', clone(member[0], { sequence_no: 1, status: 'departed', added_by_user_id: actor.id }));
    await db.execute('UPDATE warehouse_packing_jobs SET dispatch_id=? WHERE id=? AND organization_id=?', [dispatchId,ids.get(packJob.id),org]);
    await insert('warehouse_dispatch_items', { id: randomUUID(), organization_id: org, dispatch_id: dispatchId, package_id: ids.get(oul[0].id), status: 'loaded', loaded_by_user_id: actor.id, loaded_at: at(130), notes: note });
    await db.execute("UPDATE warehouse_packing_jobs SET status='loading' WHERE id=? AND organization_id=?", [ids.get(packJob.id),org]);
    await db.execute("UPDATE warehouse_packages SET status='dispatched',lifecycle_status='in_transit' WHERE id=? AND organization_id=?", [ids.get(oul[0].id),org]);
    await db.execute("UPDATE warehouse_packing_jobs SET status='dispatched' WHERE id=? AND organization_id=?", [ids.get(packJob.id),org]);
    await db.execute("UPDATE warehouse_dispatches SET status='dispatched' WHERE id=? AND organization_id=?", [dispatchId,org]);
    for (const input of inbound) await db.execute("UPDATE warehouse_packages SET status='dispatched' WHERE id=? AND organization_id=?", [ids.get(input.id),org]);
    for (const record of groups.get('order_customs_records')) await insert('order_customs_records', clone(record, { declaration_number: 'CUSTOMS-'+number, created_by_user_id: actor.id, declared_at: at(150), released_at: at(140) }));
    for (const declaration of groups.get('order_customs_declarations')) await insert('order_customs_declarations', clone(declaration, { declaration_number: 'CUSTOMS-'+number, declaration_title: '【演示】已放行', created_by_user_id: actor.id, gross_weight_kg: 120, declared_at: at(150), released_at: at(140) }));
    for (const [index, code, name] of [[0,'border_arrived','口岸到达'],[1,'exported','出境'],[2,'foreign_entered','海外入境'],[3,'customs_cleared','目的地清关']]) await insert('order_tracking_milestones', { id: randomUUID(), organization_id: org, order_id: orderId, milestone_code: code, milestone_name: name, event_at: at(120-index*25), location: index<2 ? batch.border_port : '俄罗斯 · 莫斯科', vehicle_reference: batch.overseas_vehicle_plate, notes: note, visible_to_customer: 1, created_by_user_id: actor.id, created_at: now });
    await insert('overseas_warehouse_operations', { id: randomUUID(), organization_id: org, batch_id: batchId, order_id: orderId, warehouse_id: destination, status: 'waiting_arrival', notes: note, created_at: now, updated_at: now });
    await insert('shipment_events', { id: randomUUID(), shipment_id: shipmentId, status: 'in_transit', location: warehouse.name+'待收货', description: note+' 已出境及完成目的地清关，等待仓库扫码。', event_at: at(45), visible_to_customer: 1, created_by_user_id: actor.id, created_at: now });
    await insert('audit_logs', { id: randomUUID(), organization_id: org, actor_user_id: actor.id, action: 'demo.moscow_receiving.create', resource_type: 'transport_order', resource_id: orderId, outcome: 'success', metadata_json: JSON.stringify({ demonstration: true, sourceOrderId: sourceId, orderNumber: number, batchId, dispatchId, barcode, noFinancialWrites: true, note }), created_at: now });
    const ready = await one(`SELECT o.id,o.order_number,wi.current_step_key,p.barcode,p.status package_status,p.lifecycle_status,b.road_status,d.dispatch_number,
      (SELECT COUNT(*) FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.status!='removed') members,
      (SELECT COUNT(*) FROM warehouse_receipts r WHERE r.shipment_id=s.id AND r.warehouse_id=?) overseas_receipts
      FROM transport_orders o JOIN workflow_instances wi ON wi.id=o.workflow_instance_id
      JOIN shipments s ON s.order_id=o.id JOIN warehouse_packages p ON p.shipment_id=s.id AND p.label_kind='oul'
      JOIN warehouse_dispatch_items di ON di.package_id=p.id JOIN warehouse_dispatches d ON d.id=di.dispatch_id
      JOIN transport_batches b ON b.id=d.transport_batch_id WHERE o.id=?`, [destination, orderId]);
    if (ready.members !== 1 || ready.overseas_receipts !== 0 || ready.lifecycle_status !== 'in_transit' || ready.current_step_key !== 'outbound_transport') throw new Error('Receiving-ready invariant failed');
    const newDigest = await coreDigest();
    for (const table of ['settlement_cash_transactions','settlement_cash_allocations']) if (newDigest[table].sha256 !== oldDigest[table].sha256) throw new Error('Unexpected financial mutation');
    if (newDigest.transport_orders.count !== oldDigest.transport_orders.count+1) throw new Error('Unexpected order count change');
    const oldOrders = await rows('SELECT * FROM transport_orders WHERE id<>? ORDER BY id',[orderId]);
    if (createHash('sha256').update(JSON.stringify(oldOrders)).digest('hex') !== oldDigest.transport_orders.sha256) throw new Error('An existing order changed during preparation; refusing commit');
    if (apply) await db.commit(); else await db.rollback(); begun = false;
    console.log(JSON.stringify({ applied: apply, orderId, number, batchId, batchNumber, dispatchId, barcode, warehouse: warehouse.name, warehouseAccount: warehouseActor.email, counts, ready, financialDataUnchanged: true }));
  }
} catch (error) {
  if (begun) await db.rollback();
  console.error(error.message); process.exitCode = 1;
} finally { await db.end(); }
