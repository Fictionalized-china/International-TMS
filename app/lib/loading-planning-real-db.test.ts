import { afterEach,describe,it,expect,vi } from 'vitest';
import { meetingFixture,seedFrozenMeetingWorkflow } from './meeting-integration-fixture';
const harness=vi.hoisted(()=>({db:null as unknown as D1Database}));
vi.mock('cloudflare:workers',()=>({env:{get DB(){return harness.db;}}}));
vi.mock('./order-modules.server',()=>({ensureOrderModules:async()=>{},syncOrderWorkflowSnapshot:async()=>{}}));
vi.mock('./batch-transport-sync.server',()=>({synchronizeBatchTransport:async()=>{}}));
vi.mock('./loading-manifest.server',()=>({ensureBatchSystemDocuments:async()=>true}));
import { createOperationPlannedBatch } from './loading-batch-planning.server';
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
afterEach(()=>fixture?.database.close());
describe('new loading plans against every actual database guard',()=>{
  it('creates one pre-dispatch allocation, child cost and batch, and reuses a duplicate submission',async()=>{
    fixture=await meetingFixture();harness.db=fixture.db;const sql=fixture.database,now=fixture.now;
    seedFrozenMeetingWorkflow(fixture);
    sql.exec("UPDATE workflow_instance_module_states SET responsibility_position_code='CS';UPDATE workflow_instances SET current_step_key='port_loading'");
    sql.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES('loading-step','wf','port_loading','配载','order','loading.test',70,?,?)").run(now,now);
    sql.prepare("INSERT INTO workflow_instance_step_states(id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at) VALUES('loading-state','instance','wf','loading-step','port_loading','配载',70,'active',?)").run(now);
    for(const [code,position] of [['loading','OPERATION_SUPERVISOR'],['transport','OPERATION'],['documents','DOC']]){
      sql.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,responsibility_position_code,created_at,updated_at) VALUES(?,'wf','loading-step',?,?,?,?,?)").run(`placement:${code}`,code,code,position,now,now);
      sql.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,responsibility_position_code,updated_at) VALUES(?,'loading-state',?,?,?,10,1,'all_tasks',?,?)").run(`frozen:${code}`,`placement:${code}`,code,code,position,now);
    }
    sql.prepare("INSERT INTO users(id,email,password_hash,display_name,phone,created_at,updated_at) VALUES('doc','doc@test.local','not-a-login-hash','单证','13800009999',?,?)").run(now,now);
    sql.prepare("INSERT INTO memberships(id,organization_id,user_id,department_id,position_id,created_at,updated_at) SELECT 'member:doc','org','doc',d.id,p.id,?,? FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code WHERE p.organization_id='org' AND p.code='DOC'").run(now,now);
    for(const [id,role,serial] of [['warehouse','domestic_collection','01'],['overseas','overseas_destination','02']])sql.prepare("INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,serial_code,created_at,updated_at) VALUES(?,'org',?,?,?,?,?,?)").run(id,id,id,role,serial,now,now);
    sql.exec("UPDATE transport_orders SET overseas_warehouse_id='overseas' WHERE id='order'");
    sql.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','warehouse','Z','收货区',?,?)").run(now,now);
    sql.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('location','org','warehouse','zone','L','库位',?,?)").run(now,now);
    sql.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,created_at,updated_at) VALUES('shipment','org','SHIP-TEST','order','customer',?,?)").run(now,now);
    sql.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,cargo_complete,received_at,created_at,updated_at) VALUES('receipt','org','IN-TEST','shipment','warehouse','location',1,?,?,?)").run(now,now,now);
    sql.prepare("INSERT INTO warehouse_packing_jobs(id,organization_id,warehouse_id,order_id,shipment_id,packing_mode,source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,status,created_at,updated_at) VALUES('job','org','warehouse','order','shipment','preserve',1,1,100,1,'labelled',?,?)").run(now,now);
    for(const [id,kind,job] of [['inbound','inbound_mark',null],['outbound','oul','job']])sql.prepare("INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,weight_kg,volume_cbm,length_cm,width_cm,height_cm,label_kind,packing_job_id,created_at,updated_at) VALUES(?,'org','receipt','shipment','warehouse','location',?,?,100,1,100,100,100,?,?,?,?)").run(id,id,id,kind,job,now,now);
    sql.prepare("INSERT INTO warehouse_packing_job_sources(id,organization_id,packing_job_id,inbound_warehouse_package_id,created_at) VALUES('source','org','job','inbound',?)").run(now);
    sql.prepare("INSERT INTO carriers(id,organization_id,code,name,carrier_scope,created_at,updated_at) VALUES('carrier','org','CAR','境外资源','overseas',?,?)").run(now,now);
    sql.prepare("INSERT INTO carrier_vehicles(id,organization_id,carrier_id,plate_number,vehicle_type,created_at,updated_at) VALUES('vehicle','org','carrier','TEST-001','truck',?,?)").run(now,now);
    sql.prepare("INSERT INTO carrier_drivers(id,organization_id,carrier_id,name,phone,created_at,updated_at) VALUES('driver','org','carrier','司机','123456',?,?)").run(now,now);
    // Clone the complete second order, including its own immutable workflow and packaging.
    const tables=['transport_orders','workflow_instances','workflow_instance_step_states','workflow_instance_module_states','workflow_instance_fields','order_module_instances','shipments','warehouse_receipts','warehouse_packing_jobs','warehouse_packages','warehouse_packing_job_sources'];
    const records=tables.flatMap(table=>(sql.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[]).map(row=>({table,row})));
    const ids=new Map(records.map(({row})=>[row.id as string,`second-${row.id}`]));
    sql.exec('BEGIN;PRAGMA defer_foreign_keys=ON');
    for(const {table,row} of records){const columns=Object.keys(row);const values=columns.map(key=>{const value=row[key];return typeof value==='string'?(ids.get(value)??(['order_number','shipment_number','receipt_number','barcode','package_number'].includes(key)?`${value}-2`:value)):value;});sql.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values as import('node:sqlite').SQLInputValue[]);}
    sql.exec('COMMIT');
    const request={current:fixture.actors.get('supervisor')!,requestId:'request-new-plan-001',orderIds:['order','second-order'],batchName:'回归测试',carrierId:'carrier',vehicleId:'vehicle',driverId:'driver',borderPort:'',customsLocation:'',plannedLoadingAt:'',plannedDepartureAt:'',plannedArrivalAt:'',routeNotes:'',notes:'',operationAssigneeUserId:'operation',documentAssigneeUserId:'doc',costAmount:60,costCurrency:'CNY',costExchangeRate:1,costAllocationMethod:'auto' as const};
    const result=await createOperationPlannedBatch(request);expect(result.syncPending).toBe(false);
    expect(await createOperationPlannedBatch(request)).toEqual(result);
    expect(sql.prepare('SELECT COUNT(*) n FROM transport_batches').get()?.n).toBe(1);
    expect(sql.prepare("SELECT stage,amount,source_type FROM business_expenses").get()).toMatchObject({stage:'estimated',amount:30,source_type:'loading_cost_allocation_line'});
    expect(sql.prepare('SELECT COUNT(*) n,SUM(amount) amount FROM business_expenses').get()).toMatchObject({n:2,amount:60});
    expect(sql.prepare('SELECT status,creation_mode FROM transport_cost_allocations').get()).toMatchObject({status:'confirmed',creation_mode:'planning'});
    expect(sql.prepare('SELECT COUNT(*) n FROM warehouse_dispatches').get()?.n).toBe(0);
  });
});
