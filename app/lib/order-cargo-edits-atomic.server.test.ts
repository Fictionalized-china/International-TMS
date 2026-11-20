import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {meetingFixture} from './meeting-integration-fixture';
import {saveOrderCargoItem} from './order-cargo-editor.server';
vi.mock('cloudflare:workers',()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();fixture.database.exec("UPDATE transport_orders SET status='draft'");});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
function form(){const data=new FormData();for(const[key,value]of Object.entries({cargoRequestKey:crypto.randomUUID(),cargoOrderVersion:fixture.now,cargoName:'设备',packageType:'carton',packageCount:'2',piecesPerPackage:'1',weight:'20',volume:'0',currency:'CNY'}))data.set(key,value);return data;}
const save=(body=form(),actorUserId='owner',mode:'create'|'update'='create')=>saveOrderCargoItem({db:fixture.db,organizationId:'org',orderId:'order',orderNumber:'TEST-SO',actorUserId,mode,form:body,workflowFields:[]});
describe('atomic cargo editing and retry identity',()=>{
  it('creates cargo, sequential labels, audit and retry receipt once, even after the displayed order version changes',async()=>{
    const body=form(),first=await save(body);expect(first).toMatchObject({ok:true,created:true,packageCount:2});
    body.set('cargoOrderVersion','newer-view-version');expect(await save(body)).toEqual(first);
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_cargo_items').get()?.n).toBe(1);
    expect(fixture.database.prepare('SELECT package_code FROM order_cargo_packages ORDER BY package_code').all()).toEqual([{package_code:'TEST-SO-IN-001'},{package_code:'TEST-SO-IN-002'}]);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.cargo.create'").get()?.n).toBe(1);
    body.set('weight','30');expect(await save(body)).toMatchObject({ok:false,error:expect.stringContaining('内容已变化')});
  });
  it('rejects stale windows before saving any cargo or labels',async()=>{const body=form();body.set('cargoOrderVersion','old');expect(await save(body)).toMatchObject({ok:false,error:expect.stringContaining('其他窗口')});expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_cargo_items').get()?.n).toBe(0);});
  it.each(['authority','parent','package','audit'])('rolls back the entire cargo edit on %s competition/failure',async change=>{
    const body=form(),original=fixture.db.batch.bind(fixture.db);
    vi.spyOn(fixture.db,'batch').mockImplementationOnce(async statements=>{
      if(change==='authority')fixture.database.exec("UPDATE users SET status='disabled' WHERE id='owner'");
      if(change==='parent')fixture.database.exec("UPDATE transport_orders SET updated_at='newer'");
      if(change==='package')fixture.database.exec("UPDATE transport_orders SET inbound_package_locked_at='scan-started'");
      if(change==='audit')fixture.database.exec("CREATE TRIGGER fail_cargo_audit BEFORE INSERT ON audit_logs WHEN NEW.action='order.cargo.create' BEGIN SELECT RAISE(ABORT,'audit failed');END");
      return original(statements);
    });
    await expect(save(body)).rejects.toThrow();
    for(const table of ['order_cargo_items','order_cargo_packages','order_cargo_edit_submissions'])expect(fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(0);
  });
  it('does not modify received declarations while still permitting notes and additional images',async()=>{
    const first=await save();if(!first.ok)throw new Error(first.error);
    fixture.database.exec("UPDATE order_cargo_packages SET status='received'");
    const body=form();body.set('cargoItemId',first.itemId);body.set('cargoOrderVersion',String(fixture.database.prepare('SELECT updated_at FROM transport_orders').get()?.updated_at));body.set('weight','999');
    expect(await save(body,'owner','update')).toMatchObject({ok:false,error:expect.stringContaining('已进入仓储')});
    body.set('weight','20');body.set('notes','客户补充的货物说明');expect(await save(body,'owner','update')).toMatchObject({ok:true});
    expect(fixture.database.prepare('SELECT gross_weight_per_package_kg,notes FROM order_cargo_items').get()).toEqual({gross_weight_per_package_kg:20,notes:'客户补充的货物说明'});
  });
  it.each(['finance','cashier','tracker','hr'])('does not grant %s cargo write access',async actor=>{expect(await save(form(),actor)).toMatchObject({ok:false});});
});
