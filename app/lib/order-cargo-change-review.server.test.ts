import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {meetingFixture} from './meeting-integration-fixture';
import {saveOrderCargoItem} from './order-cargo-editor.server';
import {saveOrRequestOrderCargoChange,reviewOrderIntakeChange} from './order-intake-changes.server';
vi.mock('cloudflare:workers',()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>,itemId:string;
beforeEach(async()=>{
  fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});fixture.database.exec("UPDATE transport_orders SET status='draft'");
  const result=await saveOrderCargoItem(input(body(),'owner','create'));if(!result.ok)throw new Error(result.error);itemId=result.itemId;
  fixture.database.exec("UPDATE transport_orders SET status='in_execution'");
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
function body(){const form=new FormData();for(const[key,value]of Object.entries({cargoRequestKey:crypto.randomUUID(),cargoOrderVersion:String(fixture.database.prepare('SELECT updated_at FROM transport_orders').get()?.updated_at),cargoName:'设备',packageType:'carton',packageCount:'2',piecesPerPackage:'1',weight:'20',volume:'0',currency:'CNY',cargoChangeReason:'客户更正重量，已核实书面委托'}))form.set(key,value);return form;}
function input(form:FormData,who='sales',mode:'create'|'update'='update'){return{db:fixture.db,organizationId:'org',orderId:'order',orderNumber:'TEST-SO',actorUserId:who,mode,form,workflowFields:[]};}
function edited(){const form=body();form.set('cargoItemId',itemId);form.set('weight','30');return form;}
const propose=(form=edited(),who='sales',mode:'create'|'update'='update')=>saveOrRequestOrderCargoChange(fixture.actors.get(who)!,input(form,who,mode));
function reviewBody(){const form=new FormData();form.set('changeId',String(fixture.database.prepare("SELECT id FROM order_intake_change_requests WHERE status='pending'").get()?.id));form.set('decision','approved');form.set('reviewNotes','核对原始委托后同意更正');return form;}
const review=(form=reviewBody(),who='supervisor')=>reviewOrderIntakeChange(fixture.actors.get(who)!,'order',form);
describe('approved cargo material review',()=>{
  it('proposes without editing cargo, then atomically applies the reviewed change once',async()=>{
    const form=edited();expect(await propose(form)).toMatchObject({ok:true,pendingReview:true});
    expect(fixture.database.prepare('SELECT gross_weight_per_package_kg FROM order_cargo_items').get()?.gross_weight_per_package_kg).toBe(20);
    expect(await propose(form)).toMatchObject({ok:true,pendingReview:true});
    const decision=reviewBody();await review(decision);await review(decision);
    expect(fixture.database.prepare('SELECT gross_weight_per_package_kg FROM order_cargo_items').get()?.gross_weight_per_package_kg).toBe(30);
    expect(fixture.database.prepare('SELECT gross_weight_kg FROM transport_orders').get()?.gross_weight_kg).toBe(60);
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_cargo_packages').get()?.n).toBe(2);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.cargo.update'").get()?.n).toBe(1);
    expect(await propose(form)).toMatchObject({ok:true,pendingReview:true,success:expect.stringContaining('已应用')});
  });
  it('keeps new post-approval packages unissued until the boss reviews, then continues the global sequence',async()=>{
    const form=body();await propose(form,'owner','create');expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_cargo_packages').get()?.n).toBe(2);
    await review(reviewBody(),'owner');expect(fixture.database.prepare('SELECT package_code FROM order_cargo_packages ORDER BY package_code').all()).toEqual([1,2,3,4].map(index=>({package_code:`TEST-SO-IN-${String(index).padStart(3,'0')}`})));
  });
  it('does not require new approval merely to supplement notes or images',async()=>{
    const form=body();form.set('cargoItemId',itemId);form.set('notes','补充说明');form.delete('cargoChangeReason');
    expect(await propose(form)).toMatchObject({ok:true,pendingReview:false});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_intake_change_requests').get()?.n).toBe(0);
  });
  it('cannot bypass review by calling the direct cargo service after approval',async()=>{expect(await saveOrderCargoItem(input(edited(),'owner'))).toMatchObject({ok:false,error:expect.stringContaining('须先申请')});});
  it('refuses approval after receipt begins, keeping cargo facts and the pending request unchanged',async()=>{
    await propose();fixture.database.exec("UPDATE order_cargo_packages SET status='received';UPDATE transport_orders SET inbound_package_locked_at='2026-11-17T01:00:00Z'");
    await expect(review()).rejects.toThrow('仓储');
    expect(fixture.database.prepare('SELECT gross_weight_per_package_kg FROM order_cargo_items').get()?.gross_weight_per_package_kg).toBe(20);
    expect(fixture.database.prepare('SELECT status FROM order_intake_change_requests').get()?.status).toBe('pending');
  });
  it('rolls back cargo, aggregates, labels and approval if audit fails in the same transaction',async()=>{
    await propose();fixture.database.exec("CREATE TRIGGER fail_review BEFORE INSERT ON audit_logs WHEN NEW.action='order.intake.change.approved' BEGIN SELECT RAISE(ABORT,'audit failed');END");
    await expect(review()).rejects.toThrow();expect(fixture.database.prepare('SELECT gross_weight_per_package_kg FROM order_cargo_items').get()?.gross_weight_per_package_kg).toBe(20);
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_cargo_packages').get()?.n).toBe(2);
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_cargo_edit_submissions').get()?.n).toBe(1);
    expect(fixture.database.prepare('SELECT status FROM order_intake_change_requests').get()?.status).toBe('pending');
  });
});
