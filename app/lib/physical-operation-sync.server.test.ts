import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {meetingFixture} from './meeting-integration-fixture';
import {predicateGuard} from './mutation-guard.server';
const state=vi.hoisted(()=>({env:{} as {DB:D1Database},progress:vi.fn(),workflow:vi.fn(),sorting:vi.fn(),transport:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:state.env}));
vi.mock('./warehouse-progress.server',()=>({recordWarehouseProgress:state.progress}));
vi.mock('./business-workflow.server',()=>({recordWorkflowEvent:state.workflow}));
vi.mock('./warehouse-receipt-projection.server',()=>({ensureVerifiedReceivingBatch:state.sorting,completeDomesticTransport:state.transport}));
import {physicalSyncJobId,physicalSyncJobStatement,runPhysicalSyncJob} from './physical-operation-sync.server';
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  fixture=await meetingFixture();state.env.DB=fixture.db;
  for(const fn of [state.progress,state.workflow,state.sorting,state.transport])fn.mockReset().mockResolvedValue(undefined);
  const sql=fixture.database,n=fixture.now;
  sql.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('wh','org','WH','国内仓',?,?)").run(n,n);
  sql.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','wh','Z','到货区',?,?)").run(n,n);
  sql.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('loc','org','wh','zone','L','收货位',?,?)").run(n,n);
  sql.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,created_at,updated_at) VALUES('shipment','org','SHP','order','customer','picked_up',?,?)").run(n,n);
  sql.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,total_packages,total_weight_kg,total_volume_cbm,cargo_complete,received_by_user_id,received_at,created_at,updated_at) VALUES('receipt','org','IN','shipment','wh','loc','completed',1,10,0,1,'owner',?,?,?)").run(n,n,n);
});
afterEach(()=>fixture?.database.close());
const id=physicalSyncJobId('domestic_receipt','receipt');
async function enqueue(result='ready'){await fixture.db.batch([physicalSyncJobStatement(fixture.db,{organizationId:'org',orderId:'order',warehouseId:'wh',actorUserId:'owner',kind:'domestic_receipt',sourceId:'receipt',payload:{result,packageCount:1},now:fixture.now})]);}
const row=()=>fixture.database.prepare('SELECT status,attempts,last_error FROM physical_operation_sync_jobs').get();
describe('durable physical projection retries against migrated tables',()=>{
  it('retains the actual receipt after projection fails and retries only derived state once',async()=>{
    const facts=fixture.database.prepare('SELECT * FROM warehouse_receipts').get();await enqueue();
    state.progress.mockRejectedValueOnce(new Error('配置待补齐'));
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({syncPending:true});
    expect(row()).toMatchObject({status:'pending',attempts:1,last_error:'配置待补齐'});
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({syncPending:false});
    expect(row()).toMatchObject({status:'completed',attempts:2,last_error:null});
    const calls=state.progress.mock.calls.length;
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({syncPending:false});
    expect(state.progress).toHaveBeenCalledTimes(calls);expect(fixture.database.prepare('SELECT * FROM warehouse_receipts').get()).toEqual(facts);
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM business_expenses').get()?.n).toBe(0);
  });
  it('does not claim another organization or a live lease; recovers an expired lease',async()=>{
    await enqueue();expect(await runPhysicalSyncJob(fixture.db,'another-org',id)).toMatchObject({syncPending:true});
    fixture.database.exec("UPDATE physical_operation_sync_jobs SET status='running',lease_token='other',lease_until='2999-01-01T00:00:00.000Z'");
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({busy:true});expect(state.progress).not.toHaveBeenCalled();
    fixture.database.exec("UPDATE physical_operation_sync_jobs SET lease_until='2000-01-01T00:00:00.000Z'");
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({syncPending:false});
  });
  it('rejects stale retry authority in the same claim transaction',async()=>{
    await enqueue();await expect(runPhysicalSyncJob(fixture.db,'org',id,[predicateGuard(fixture.db,'0=1',[],fixture.now)])).rejects.toThrow();
    expect(row()).toMatchObject({status:'pending',attempts:0});expect(state.progress).not.toHaveBeenCalled();
  });
  it('never advances missing or withdrawn physical facts',async()=>{
    await enqueue();fixture.database.exec("UPDATE warehouse_receipts SET status='cancelled' WHERE id='receipt'");
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({syncPending:true});expect(state.workflow).not.toHaveBeenCalled();
  });
  it('does not mark remaining cargo or its domestic transport complete after a partial receipt',async()=>{
    fixture.database.exec("UPDATE warehouse_receipts SET cargo_complete=0 WHERE id='receipt'");await enqueue('partial');
    expect(await runPhysicalSyncJob(fixture.db,'org',id)).toMatchObject({syncPending:false});
    expect(state.sorting).not.toHaveBeenCalled();expect(state.transport).not.toHaveBeenCalled();expect(state.progress).toHaveBeenCalledWith(expect.objectContaining({stepCode:'receiving'}));
  });
});
