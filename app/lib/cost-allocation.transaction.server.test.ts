import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {meetingFixture,seedFrozenMeetingWorkflow} from "./meeting-integration-fixture";
import {createCostAllocation,updateCostAllocation,confirmCostAllocation} from "./cost-allocation.server";
import {loadBatchCostAllocationActionPolicy} from "./batch-cost-allocation-action-policy.server";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
const noop=async()=>{};
beforeEach(async()=>{
  fixture=await meetingFixture();seedFrozenMeetingWorkflow(fixture);
  const s=fixture.database,n=fixture.now;
  s.exec("UPDATE workflow_instances SET current_step_key='order_creation'; UPDATE workflow_instance_step_states SET status=CASE WHEN step_key='order_creation' THEN 'active' ELSE 'pending' END");
  s.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES('placement:loading','wf','step:order_creation','loading','配载',?,?)").run(n,n);
  s.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,updated_at) VALUES('loading-state','state:order_creation','placement:loading','loading','配载',20,0,'all_tasks',?)").run(n);
  s.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES('allocation-field','instance','wf','order_creation','loading','cost_allocation','分摊','text',0,1,?)").run(n);
  s.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('wh','org','WH','国内仓',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','wh','Z','到货',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('loc','org','wh','zone','L','收货位',?,?)").run(n,n);
  s.prepare("INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,warehouse_id,approval_status,status,created_at,updated_at) VALUES('batch','org','order','PZ-TEST','配载','国内','莫斯科','wh','approved','loading',?,?)").run(n,n);
  s.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,created_at,updated_at) VALUES('shipment','org','SHP','order','customer','picked_up',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,total_packages,total_weight_kg,total_volume_cbm,cargo_complete,received_by_user_id,received_at,created_at,updated_at) VALUES('receipt','org','IN','shipment','wh','loc','completed',1,10,1,1,'owner',?,?,?)").run(n,n,n);
  s.prepare("INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,weight_kg,volume_cbm,status,label_kind,lifecycle_status,created_at,updated_at) VALUES('inbound','org','receipt','shipment','wh','loc','IN-001','IN-001',1,10,1,'in_stock','inbound_mark','active',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_packing_jobs(id,organization_id,warehouse_id,order_id,shipment_id,packing_mode,source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,status,created_at,updated_at) VALUES('packing','org','wh','order','shipment','preserve',1,1,10,1,'generated',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_packing_job_sources(id,organization_id,packing_job_id,inbound_warehouse_package_id,created_at) VALUES('source','org','packing','inbound',?)").run(n);
  s.prepare("INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,weight_kg,volume_cbm,length_cm,width_cm,height_cm,status,label_kind,lifecycle_status,packing_job_id,created_at,updated_at) VALUES('oul','org','receipt','shipment','wh','loc','OUL-001','OUL-001',1,10,1,100,100,100,'in_stock','oul','active','packing',?,?)").run(n,n);
  s.exec("UPDATE warehouse_packages SET status='allocated' WHERE id='inbound'; UPDATE warehouse_packing_jobs SET status='labelled' WHERE id='packing'; UPDATE warehouse_packing_jobs SET status='allocated',transport_batch_id='batch' WHERE id='packing'");
  s.prepare("INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,created_at,updated_at) VALUES('bo','org','batch','order',1,?,?)").run(n,n);
  s.prepare("INSERT INTO transport_batch_packages(id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES('bp','org','batch','order','packing','oul',1,'planned','owner',?,?)").run(n,n);
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
const create=(totalAmount=100,currency="CNY",exchangeRate=1)=>createCostAllocation(fixture.db,{organizationId:"org",batchId:"batch",chargeCode:"FREIGHT",chargeName:"境外运费",counterpartyName:"承运人",currency,exchangeRate,totalAmount,method:"equal",userId:"owner",now:fixture.now,assertCanMutate:noop});
const confirm=(id:string,assertCanMutate=noop)=>confirmCostAllocation(fixture.db,{organizationId:"org",allocationId:id,userId:"owner",now:fixture.now,assertCanMutate});
const count=(table:string)=>Number(fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
function appendActualOrder(index:number,weight=10){
  const s=fixture.database,suffix=`:${index}`,orderId=`order${suffix}`;
  function copy(table:string,where:string,changes:(row:Record<string,unknown>)=>Record<string,unknown>){
    for(const row of s.prepare(`SELECT * FROM ${table} WHERE ${where}`).all()){
      const next={...row,...changes(row)},keys=Object.keys(next);
      s.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>next[key]) as (string|number|null)[]);
    }
  }
  copy('transport_orders',"id='order'",()=>({id:orderId,order_number:`SO-${index}`,workflow_instance_id:null}));
  copy('workflow_instances',"id='instance'",()=>({id:`instance${suffix}`,order_id:orderId}));
  s.prepare('UPDATE transport_orders SET workflow_instance_id=? WHERE id=?').run(`instance${suffix}`,orderId);
  copy('workflow_instance_step_states',"instance_id='instance'",row=>({id:`${row.id}${suffix}`,instance_id:`instance${suffix}`}));
  copy('workflow_instance_module_states',"instance_step_state_id IN ('state:order_creation','state:reconciliation')",row=>({id:`${row.id}${suffix}`,instance_step_state_id:`${row.instance_step_state_id}${suffix}`}));
  copy('workflow_instance_fields',"instance_id='instance'",row=>({id:`${row.id}${suffix}`,instance_id:`instance${suffix}`}));
  copy('order_module_instances',"order_id='order'",row=>({id:`${row.id}${suffix}`,order_id:orderId}));
  copy('shipments',"id='shipment'",()=>({id:`shipment${suffix}`,shipment_number:`SHP-${index}`,order_id:orderId}));
  copy('warehouse_receipts',"id='receipt'",()=>({id:`receipt${suffix}`,receipt_number:`IN-${index}`,shipment_id:`shipment${suffix}`,total_weight_kg:weight}));
  copy('warehouse_packages',"id='inbound'",()=>({id:`inbound${suffix}`,receipt_id:`receipt${suffix}`,shipment_id:`shipment${suffix}`,barcode:`IN-${index}`,package_number:`IN-${index}`,status:'in_stock',weight_kg:weight}));
  copy('warehouse_packing_jobs',"id='packing'",()=>({id:`packing${suffix}`,order_id:orderId,shipment_id:`shipment${suffix}`,transport_batch_id:null,status:'generated',total_weight_kg:weight}));
  copy('warehouse_packing_job_sources',"id='source'",()=>({id:`source${suffix}`,packing_job_id:`packing${suffix}`,inbound_warehouse_package_id:`inbound${suffix}`}));
  copy('warehouse_packages',"id='oul'",()=>({id:`oul${suffix}`,receipt_id:`receipt${suffix}`,shipment_id:`shipment${suffix}`,barcode:`OUL-${index}`,package_number:`OUL-${index}`,packing_job_id:`packing${suffix}`,weight_kg:weight}));
  s.prepare("UPDATE warehouse_packages SET status='allocated' WHERE id=?").run(`inbound${suffix}`);
  s.prepare("UPDATE warehouse_packing_jobs SET status='labelled' WHERE id=?").run(`packing${suffix}`);
  s.prepare("UPDATE warehouse_packing_jobs SET status='allocated',transport_batch_id='batch' WHERE id=?").run(`packing${suffix}`);
  copy('transport_batch_orders',"id='bo'",()=>({id:`bo${suffix}`,order_id:orderId,sequence_no:index}));
  s.prepare("INSERT INTO transport_batch_packages(id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'planned','owner',?,?)")
    .run(`bp${suffix}`,'org','batch',orderId,`packing${suffix}`,`oul${suffix}`,index,fixture.now,fixture.now);
}
describe("actual migrated cost-allocation service transactions",()=>{
  it('confirms three cents across six real orders without negative lines or extra cents',async()=>{
    for(let index=2;index<=6;index++)appendActualOrder(index);
    const id=await create(0.03);await confirm(id);
    const lines=fixture.database.prepare('SELECT final_amount FROM transport_cost_allocation_lines WHERE allocation_id=?').all(id);
    expect(lines).toHaveLength(6);expect(lines.every(row=>Number(row.final_amount)>=0)).toBe(true);
    expect(lines.reduce((sum,row)=>sum+Math.round(Number(row.final_amount)*100),0)).toBe(3);
    expect(Number(fixture.database.prepare('SELECT SUM(amount) amount FROM business_expenses').get()?.amount)).toBeCloseTo(0.03,10);
    await expect(confirm(id)).rejects.toThrow();expect(count('transport_cost_allocation_lines')).toBe(6);
  });
  it('keeps unequal measured bases and requires a reason for a balanced manual adjustment',async()=>{
    appendActualOrder(2,30);const id=await create(10),lines=fixture.database.prepare('SELECT id FROM transport_cost_allocation_lines ORDER BY order_id').all();
    await updateCostAllocation(fixture.db,{organizationId:'org',allocationId:id,method:'weight',adjustments:lines.map((row,index)=>({lineId:String(row.id),amount:index===0?2.5:7.5,reason:''})),now:fixture.now,assertCanMutate:noop});
    expect(fixture.database.prepare('SELECT suggested_amount FROM transport_cost_allocation_lines ORDER BY order_id').all().map(row=>row.suggested_amount)).toEqual([2.5,7.5]);
    await expect(updateCostAllocation(fixture.db,{organizationId:'org',allocationId:id,method:'weight',adjustments:lines.map(row=>({lineId:String(row.id),amount:5,reason:''})),now:fixture.now,assertCanMutate:noop})).rejects.toThrow();
    await updateCostAllocation(fixture.db,{organizationId:'org',allocationId:id,method:'weight',adjustments:lines.map(row=>({lineId:String(row.id),amount:5,reason:'双方确认按票均摊'})),now:fixture.now,assertCanMutate:noop});
    await confirm(id);expect(fixture.database.prepare('SELECT amount FROM business_expenses ORDER BY order_id').all().map(row=>row.amount)).toEqual([5,5]);
  });
  it("creates, updates and confirms a foreign-currency draft once without changing the conversion rate",async()=>{
    expect((await loadBatchCostAllocationActionPolicy({db:fixture.db,organizationId:"org",batchId:"batch"})).policy.editable).toBe(true);
    const id=await create(0.03,"USD",7.25),line=fixture.database.prepare("SELECT id FROM transport_cost_allocation_lines").get()!;
    await updateCostAllocation(fixture.db,{organizationId:"org",allocationId:id,method:"weight",adjustments:[{lineId:String(line.id),amount:0.03,reason:""}],now:fixture.now,assertCanMutate:noop});
    await confirm(id);expect(count("business_expenses")).toBe(1);
    expect(fixture.database.prepare("SELECT amount,currency,exchange_rate FROM business_expenses").get()).toEqual({amount:0.03,currency:"USD",exchange_rate:7.25});
    await expect(confirm(id)).rejects.toThrow("已确认");expect(count("business_expenses")).toBe(1);
  });
  it.each([0,-1,Infinity,0.001,1.001])("rejects invalid total %s without any draft or payable",async total=>{
    await expect(create(total)).rejects.toThrow();expect(count("transport_cost_allocations")).toBe(0);expect(count("business_expenses")).toBe(0);
  });
  it("rolls back all payable rows if a line refuses its expense link",async()=>{
    const id=await create();fixture.database.exec("CREATE TRIGGER lose_allocation_link BEFORE UPDATE OF expense_id ON transport_cost_allocation_lines BEGIN SELECT RAISE(IGNORE); END");
    await expect(confirm(id)).rejects.toThrow("状态已被其他人更新");expect(count("business_expenses")).toBe(0);
    expect(fixture.database.prepare("SELECT status FROM transport_cost_allocations").get()?.status).toBe("draft");
  });
  it("detects a changed draft or signed payable made after preflight, without leaving partial expenses",async()=>{
    const id=await create();
    await expect(confirm(id,async()=>{fixture.database.prepare("INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,finance_locked,updated_at) VALUES('org','order','payable',1,?)").run(fixture.now);})).rejects.toThrow("状态已被其他人更新");
    expect(count("business_expenses")).toBe(0);expect(fixture.database.prepare("SELECT status FROM transport_cost_allocations").get()?.status).toBe("draft");
  });
  it("does not use a receiving basis withdrawn after the proposal was calculated",async()=>{
    await expect(createCostAllocation(fixture.db,{organizationId:"org",batchId:"batch",chargeCode:"FREIGHT",chargeName:"运费",counterpartyName:"承运人",currency:"CNY",exchangeRate:1,totalAmount:10,method:"weight",userId:"owner",now:fixture.now,assertCanMutate:async()=>{fixture.database.exec("UPDATE warehouse_receipts SET status='cancelled' WHERE id='receipt'");}})).rejects.toThrow("状态已被其他人更新");
    expect(count("transport_cost_allocations")).toBe(0);
  });
  it("uses final packing measurements when domestic receipt volume was optional",async()=>{
    fixture.database.exec("UPDATE warehouse_receipts SET total_volume_cbm=0 WHERE id='receipt'");
    const id=await createCostAllocation(fixture.db,{organizationId:"org",batchId:"batch",chargeCode:"FREIGHT",chargeName:"运费",counterpartyName:"承运人",currency:"CNY",exchangeRate:1,totalAmount:10,method:"auto",userId:"owner",now:fixture.now,assertCanMutate:noop});
    expect(fixture.database.prepare("SELECT total_actual_weight_kg,total_actual_volume_cbm FROM transport_cost_allocations WHERE id=?").get(id)).toEqual({total_actual_weight_kg:10,total_actual_volume_cbm:1});
  });
});
