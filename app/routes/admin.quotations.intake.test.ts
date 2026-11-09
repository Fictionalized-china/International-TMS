import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { meetingFixture } from '../lib/meeting-integration-fixture';
import { ensureDefaultWorkflow } from '../lib/business-workflow.server';
import { requireSessionUser } from '../lib/auth.server';
import { action } from './admin.quotations';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/auth.server', () => ({ requireSessionUser: vi.fn() }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture();
  Object.assign(env, { DB: fixture.db });
  vi.mocked(requireSessionUser).mockResolvedValue(fixture.actors.get('sales')!);
  await ensureDefaultWorkflow('org');
  fixture.database.exec("UPDATE workflow_definitions SET lifecycle_status='published',validation_status='valid',status='active'");
  for (const workflowId of ['org:tms-default','org:tms-ftl-standard']) {
    fixture.database.prepare(`INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,is_active,created_at,updated_at)
      VALUES(?,?,'quotation','报价','quote','quote.created',10,0,?,?)`).run(`${workflowId}:quote`,workflowId,fixture.now,fixture.now);
  }
  for (const [category, code, name, parent] of [
    ['country','CN','中国',null], ['province','GD','广东','CN'], ['city','SZ','深圳','GD'],
    ['country','RU','俄罗斯',null], ['province','MOS','莫斯科州','RU'], ['city','MOW','莫斯科','MOS'],
  ]) fixture.database.prepare(`INSERT INTO reference_data(id,organization_id,category,code,name,parent_code,created_at,updated_at)
    VALUES(?,'org',?,?,?,?,?,?)`).run(code!, category!, code!, name!, parent, fixture.now, fixture.now);
  fixture.database.prepare(`INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,created_at,updated_at)
    VALUES('dest','org','DEST','目的仓','overseas_destination',?,?)`).run(fixture.now, fixture.now);
});
afterEach(() => fixture?.database.close());

function form(type = 'ltl', mode = 'direct') {
  const data = new FormData();
  const values = {
    intent:'create', entryMode:mode, intakeRequestId:crypto.randomUUID(), customerId:'customer',
    salespersonId:'sales', transportMode:'ROAD', roadLoadType:type,
    workflowDefinitionId:type === 'ftl' ? 'org:tms-ftl-standard' : 'org:tms-default',
    customerContactName:'联系人', customerContactPhone:'13800000000',
    pickupAddress:'工厂', originCountry:'中国', originState:'广东', originCity:'深圳',
    destinationCountry:'俄罗斯', destinationState:'莫斯科州', destinationCity:'莫斯科',
    destinationWarehouseId:'dest', customsClearanceMode:'company', cargoDescription:'测试货物',
    pieces:'1', plannedPackageCount:'1', declaredQuantityUnit:'件', plannedPackageType:'carton',
    weight:'100', length:'100', width:'100', height:'100', volume:'1',
    chargeName:'国际汽运费', chargeQuantity:'1', chargeUnitPrice:'100', chargeNotes:'',
  };
  for (const [key,value] of Object.entries(values)) data.set(key,value);
  for (const code of type === 'ftl' ? ['pickup','handling','storage','customs_port','overseas_driver','transit_customs'] : ['pickup']) {
    for (const [key,value] of Object.entries({intakePayableCode:code,intakePayableQuantity:'1',intakePayableUnitPrice:'0',intakePayableCounterparty:'客户自送/无费用',intakePayableNotes:''})) data.append(key,value);
  }
  return data;
}
const submit = (body: FormData) => action({request:new Request('http://localhost/admin/quotations?entryMode=direct', {method:'POST',body}),params:{},context:undefined} as never);

describe('real intake action with quotation node unplugged', () => {
  it('rejects a receivable pickup line instead of a missing payable pickup line before any order writes', async () => {
    const body = form();
    for (const key of ['intakePayableCode','intakePayableQuantity','intakePayableUnitPrice','intakePayableCounterparty','intakePayableNotes']) body.delete(key);
    body.set('chargeName','提货费');
    expect(await submit(body)).toMatchObject({entryMode:'direct',formError:expect.stringContaining('提货费')});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM quotations').get()).toMatchObject({n:0});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM transport_orders WHERE quotation_id IS NOT NULL').get()).toMatchObject({n:0});
  });
  it.each(['ltl','ftl'])('%s: a rounded-zero submission still creates tiny cargo without a volume gate', async type => {
    const body = form(type);
    body.set('length','1'); body.set('width','1'); body.set('height','0.1'); body.set('volume','0');
    const result = await submit(body);
    expect(result, JSON.stringify(result)).toMatchObject({orderId:expect.any(String)});
    if (!('orderId' in result)) throw new Error(JSON.stringify(result));
    const order = fixture.database.prepare('SELECT volume_cbm FROM transport_orders WHERE id=?').get(result.orderId!) as { volume_cbm: number };
    expect(order.volume_cbm).toBe(0.0000001);
    const cargo = fixture.database.prepare('SELECT volume_per_package_cbm FROM order_cargo_items WHERE order_id=?').get(result.orderId!) as { volume_per_package_cbm: number };
    expect(cargo.volume_per_package_cbm).toBe(0.0000001);
  });
  it('accepts explicit zero volume with dimension calculation unplugged', async () => {
    fixture.database.exec("UPDATE workflow_steps SET is_active=1 WHERE id='org:tms-default:quote'");
    for (const field of ['quotation_length_cm','quotation_width_cm','quotation_height_cm']) {
      fixture.database.prepare(`INSERT INTO workflow_step_fields
        (id,workflow_id,step_id,module_code,field_key,label,field_type,is_active,is_required,created_at,updated_at)
        VALUES(?,'org:tms-default','org:tms-default:quote','cargo',?,?,'number',0,0,?,?)`)
        .run(field,field,field,fixture.now,fixture.now);
    }
    const body = form(); body.set('volume','0');
    const result = await submit(body);
    expect(result).toMatchObject({orderId:expect.any(String)});
    if (!('orderId' in result)) throw new Error(JSON.stringify(result));
    expect(fixture.database.prepare('SELECT volume_cbm FROM transport_orders WHERE id=?').get(result.orderId!)).toMatchObject({volume_cbm:0});
  });
  it.each(['-1','Infinity',''])('rejects invalid or missing required intake volume %s', async volume => {
    const body = form(); body.set('volume', volume);
    expect(await submit(body)).toMatchObject({formError:expect.stringContaining('体积')});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM quotations').get()).toMatchObject({n:0});
  });
  it.each(['ltl','ftl'])('%s: sales can create once with explicit zero fees and no mark contacts', async type => {
    const body = form(type);
    const result = await submit(body);
    expect(result, JSON.stringify(result)).toMatchObject({entryMode:'direct', orderId:expect.any(String), success:expect.any(String)});
    if (!('orderId' in result)) throw new Error(JSON.stringify(result));
    const order = fixture.database.prepare('SELECT status,current_step_code FROM transport_orders WHERE id=?').get(result.orderId!);
    expect(order).toMatchObject({status:'draft',current_step_code:'order_creation'});
    expect(await submit(body)).toMatchObject({orderId:result.orderId});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM transport_orders WHERE quotation_id IS NOT NULL').get()).toMatchObject({n:1});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM portal_notifications WHERE type='quote'").get()).toMatchObject({n:0});
  });
  it('returns direct-entry errors to the modal and permits correcting the same request', async () => {
    const body = form(); body.set('weight','');
    expect(await submit(body)).toMatchObject({intent:'create',entryMode:'direct',formError:expect.stringContaining('预计重量')});
    body.set('weight','100');
    expect(await submit(body)).toMatchObject({entryMode:'direct',orderId:expect.any(String)});
  });
  it('keeps FTL fee requirements instead of weakening the gate to make intake succeed', async () => {
    const body = form('ftl'); body.delete('intakePayableUnitPrice');
    expect(await submit(body)).toMatchObject({entryMode:'direct',formError:expect.any(String)});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM quotations').get()).toMatchObject({n:0});
  });
  it('also allows the auxiliary quote tool to freeze a workflow without a quotation node', async () => {
    expect(await submit(form('ltl','quote'))).toMatchObject({entryMode:'quote',quotationId:expect.any(String),success:expect.any(String)});
    expect(fixture.database.prepare('SELECT current_step_key FROM workflow_instances').get()).toMatchObject({current_step_key:'order_creation'});
  });
  it('direct entry bypasses an enabled quote node without skipping order-entry or approval', async () => {
    fixture.database.exec("UPDATE workflow_steps SET is_active=1 WHERE id='org:tms-default:quote'");
    fixture.database.prepare(`INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,completion_mode,created_at,updated_at)
      VALUES('quote-module','org:tms-default','org:tms-default:quote','consignment','报价资料','automatic',?,?)`).run(fixture.now,fixture.now);
    vi.mocked(requireSessionUser).mockResolvedValue(fixture.actors.get('owner')!);
    const result = await submit(form());
    expect(result,JSON.stringify(result)).toMatchObject({orderId:expect.any(String)});
    expect(fixture.database.prepare('SELECT current_step_key FROM workflow_instances').get()).toMatchObject({current_step_key:'order_creation'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM workflow_history WHERE step_key='consignment_approval'").get()).toMatchObject({n:0});
  });
  it('rejects changed replay content without creating a second order', async () => {
    const body = form();
    expect(await submit(body)).toMatchObject({orderId:expect.any(String)});
    body.set('weight','200');
    expect(await submit(body)).toMatchObject({entryMode:'direct',formError:expect.stringContaining('内容已变化')});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM transport_orders WHERE quotation_id IS NOT NULL').get()).toMatchObject({n:1});
  });
  it('fails closed for a missing order-entry node and removes the incomplete intake record', async () => {
    fixture.database.exec("UPDATE workflow_steps SET is_active=0 WHERE step_key='order_creation'");
    expect(await submit(form())).toMatchObject({entryMode:'direct',formError:expect.stringContaining('初始节点')});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM quotations').get()).toMatchObject({n:0});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM transport_orders WHERE quotation_id IS NOT NULL').get()).toMatchObject({n:0});
  });
});
