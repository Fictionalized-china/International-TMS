import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {meetingFixture} from "./meeting-integration-fixture";
const sync=vi.hoisted(()=>vi.fn(async()=>{}));
vi.mock("cloudflare:workers",()=>({env:{}}));
vi.mock("./order-modules.server",()=>({syncOrderWorkflowSnapshot:sync}));
import {advanceOverseasOrder} from "./overseas-warehouse.server";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  sync.mockReset();sync.mockResolvedValue(undefined);fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});
  fixture.database.prepare("INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,created_at,updated_at) VALUES('moscow','org','MOW','莫斯科仓','overseas_destination',?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,created_at,updated_at) VALUES('batch','org','order','TRIP-HANDOVER','演示运输','国内','莫斯科',?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO overseas_warehouse_operations(id,organization_id,batch_id,order_id,warehouse_id,status,created_at,updated_at) VALUES('operation','org','batch','order','moscow','notified',?,?)").run(fixture.now,fixture.now);
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
const handover=()=>advanceOverseasOrder({organizationId:'org',orderId:'order',actorUserId:'owner',action:'pickup',occurredAt:fixture.now,pickupContact:'实际提货人',atomicStatements:[fixture.db.prepare("UPDATE customers SET name='stock-effect' WHERE id='customer'")]});
describe('overseas handover shares the physical stock transaction',()=>{
  it('commits once, creates one pickup milestone and refuses duplicate handover',async()=>{
    expect(await handover()).toMatchObject({nextStatus:'picked_up',syncPending:false});
    await expect(handover()).rejects.toThrow('当前状态不能');
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_tracking_milestones WHERE milestone_code='picked_up'").get()).toEqual({n:1});
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({name:'stock-effect'});
  });
  it('rolls back physical stock effects and all service records when the operation changes before commit',async()=>{
    let pending=false,fired=false;const prepare=fixture.db.prepare.bind(fixture.db),batch=fixture.db.batch.bind(fixture.db);
    vi.spyOn(fixture.db,'prepare').mockImplementation(sql=>{if(sql.includes('UPDATE overseas_warehouse_operations SET status=?'))pending=true;return prepare(sql);});
    vi.spyOn(fixture.db,'batch').mockImplementation(async statements=>{if(pending&&!fired){fired=true;fixture.database.exec("UPDATE overseas_warehouse_operations SET status='cancelled' WHERE id='operation'");}return batch(statements);});
    await expect(handover()).rejects.toThrow('整批未提交');expect(fired).toBe(true);
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({name:'测试客户'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_tracking_milestones").get()).toEqual({n:0});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM mutation_commit_guards").get()).toEqual({n:0});
  });
  it('does not leave the operation picked up if the caller stock statement fails',async()=>{
    await expect(advanceOverseasOrder({organizationId:'org',orderId:'order',actorUserId:'owner',action:'pickup',occurredAt:fixture.now,atomicStatements:[fixture.db.prepare("INSERT INTO mutation_commit_guards(id,valid,created_at) VALUES('force-failure',NULL,?)").bind(fixture.now)]})).rejects.toThrow('整批未提交');
    expect(fixture.database.prepare("SELECT status FROM overseas_warehouse_operations WHERE id='operation'").get()).toEqual({status:'notified'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_tracking_milestones").get()).toEqual({n:0});
  });
  it('reports a post-commit projection retry truthfully without pretending physical handover failed',async()=>{
    sync.mockRejectedValueOnce(new Error('projection unavailable'));
    expect(await handover()).toMatchObject({nextStatus:'picked_up',syncPending:true});
    expect(fixture.database.prepare("SELECT status FROM overseas_warehouse_operations WHERE id='operation'").get()).toEqual({status:'picked_up'});
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({name:'stock-effect'});
  });
});
