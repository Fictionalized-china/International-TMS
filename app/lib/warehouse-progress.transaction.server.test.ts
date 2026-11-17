import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {meetingFixture} from './meeting-integration-fixture';
import {createIntakeRuleBinding} from './order-intake-rule';
import {defaultBusinessProcessPolicy} from './business-process-policy';
const state=vi.hoisted(()=>({env:{} as {DB:D1Database},sync:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:state.env}));
vi.mock('./order-modules.server',()=>({ensureOrderModules:async()=>undefined,syncOrderWorkflowSnapshot:state.sync}));
import {recordWarehouseProgress} from './warehouse-progress.server';
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  fixture=await meetingFixture();state.env.DB=fixture.db;state.sync.mockReset().mockResolvedValue(undefined);
  for(const code of ['warehouse','loading'])fixture.database.prepare("INSERT INTO order_module_instances(id,organization_id,order_id,module_code,module_name,status,current_step_code,created_at,updated_at) VALUES(?,'org','order',?,?,'pending','waiting',?,?)").run(`module:${code}`,code,code,fixture.now,fixture.now);
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
const progress=(stepCode:'receiving'|'loading'|'ready'='ready')=>recordWarehouseProgress({organizationId:'org',orderId:'order',actorUserId:'owner',stepCode,stepName:'测试进度',actionCode:'physical_test',actionName:'测试作业'});
describe('warehouse physical projections cannot skip intake or downgrade newer facts',()=>{
  it.each(['ready','loading'] as const)('requires the current red-field contract before %s progress is written',async step=>{
    fixture.database.prepare("UPDATE transport_orders SET intake_operations_json=? WHERE id='order'").run(JSON.stringify({intakeRule:createIntakeRuleBinding(defaultBusinessProcessPolicy)}));
    await expect(progress(step)).rejects.toThrow('开单必填资料');
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_module_history WHERE action_code='physical_test'").get()?.n).toBe(0);
  });
  it.each(['receiving','loading'] as const)('does not roll a completed module backwards when another request wins before %s commits',async step=>{
    const code=step==='receiving'?'warehouse':'loading',original=fixture.db.batch.bind(fixture.db);
    vi.spyOn(fixture.db,'batch').mockImplementationOnce(async statements=>{
      fixture.database.prepare("UPDATE order_module_instances SET status='completed',current_step_code='confirmed' WHERE module_code=?").run(code);
      return original(statements);
    });
    await expect(progress(step)).rejects.toThrow();
    expect(fixture.database.prepare('SELECT status,current_step_code FROM order_module_instances WHERE module_code=?').get(code)).toMatchObject({status:'completed',current_step_code:'confirmed'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_module_history WHERE action_code='physical_test'").get()?.n).toBe(0);
  });
  it('records the physical projection and history once and leaves a completed result unchanged on retry',async()=>{
    await progress();await progress();
    expect(fixture.database.prepare("SELECT status,current_step_code FROM order_module_instances WHERE module_code='warehouse'").get()).toMatchObject({status:'completed',current_step_code:'ready'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_module_history WHERE action_code='physical_test'").get()?.n).toBe(1);
  });
});
