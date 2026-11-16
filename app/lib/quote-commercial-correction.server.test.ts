import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {meetingFixture} from './meeting-integration-fixture';
import {correctOrderQuoteCommercial} from './order-intake-supplement.server';
vi.mock('cloudflare:workers',()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});fixture.database.exec("UPDATE transport_orders SET quote_commercial_user_id='sales',quote_commercial_name_snapshot='原报价快照' WHERE id='order'");});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
function body(){const fields=new FormData();fields.set('version',fixture.now);fields.set('correctionReason','核对原始委托后更正实际报价人');fields.set('quoteCommercialCorrectionId','commercial');return fields;}
const save=(actor='owner',fields=body())=>correctOrderQuoteCommercial(fixture.actors.get(actor)!,'order',fields);
describe('controlled commercial attribution correction',()=>{
  it.each(['owner','operation'])('allows %s to correct attribution with before/after audit, without rewriting business facts',async actor=>{
    const before=fixture.database.prepare("SELECT status,workflow_instance_id,pieces,gross_weight_kg,volume_cbm FROM transport_orders WHERE id='order'").get();
    await save(actor);expect(fixture.database.prepare("SELECT quote_commercial_user_id,quote_commercial_name_snapshot FROM transport_orders WHERE id='order'").get()).toEqual({quote_commercial_user_id:'commercial',quote_commercial_name_snapshot:'commercial'});
    expect(fixture.database.prepare("SELECT status,workflow_instance_id,pieces,gross_weight_kg,volume_cbm FROM transport_orders WHERE id='order'").get()).toEqual(before);
    const row=fixture.database.prepare("SELECT metadata_json FROM audit_logs WHERE action='order.quote_commercial.correct'").get();expect(JSON.parse(String(row?.metadata_json))).toMatchObject({before:{id:'sales',name:'原报价快照'},after:{id:'commercial'},reason:expect.any(String)});
  });
  it.each(['hr','cashier','tracker'])('does not grant %s new mutation rights',async actor=>{await expect(save(actor)).rejects.toThrow();});
  it('requires reason and current version, not an untracked edit',async()=>{
    const fields=body();fields.set('correctionReason','');await expect(save('owner',fields)).rejects.toThrow('依据');fields.set('correctionReason','核对原始委托');fields.set('version','stale');await expect(save('owner',fields)).rejects.toThrow('其他窗口');
  });
  it.each(["UPDATE users SET status='disabled' WHERE id='commercial'","UPDATE transport_orders SET status='completed' WHERE id='order'","UPDATE users SET status='disabled' WHERE id='owner'"])("rejects a concurrent change atomically (%s)",async change=>{
    const batch=fixture.db.batch.bind(fixture.db);vi.spyOn(fixture.db,'batch').mockImplementationOnce(async statements=>{fixture.database.exec(change);return batch(statements);});
    await expect(save()).rejects.toThrow('本次未保存');expect(fixture.database.prepare("SELECT quote_commercial_user_id FROM transport_orders WHERE id='order'").get()).toEqual({quote_commercial_user_id:'sales'});expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.quote_commercial.correct'").get()).toEqual({n:0});
  });
});
