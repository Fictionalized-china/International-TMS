import { afterEach,beforeEach,describe,it,expect,vi } from "vitest";
import { meetingFixture,seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { submitMeetingSignature,loadMeetingSettlement,assertMeetingSignoffsComplete,meetingSignatureAccess } from "./meeting-settlement.server";
import { loadHrReport,saveCommission,generateScheduledHrReports } from "./hr-reports.server";
import { requestDispatchTask,fulfillDispatchTask,refreshAutomaticDispatchTasks } from "./dispatch-tasks.server";
import { recordCashTransaction,allocateCashTransaction } from './settlement-workbench.server';
import { refreshTrackingAlerts } from './tracking-alerts.server';
import { loadMeetingWorkOverview } from './meeting-work-overview.server';
import { plannedCostIntegrationStatements } from './planning-cost-integration.server';
vi.mock("cloudflare:workers",()=>({env:{}}));
vi.mock('./order-review.server',()=>({refreshOrderCompletionStatus:async()=>{}}));
vi.mock('./order-modules.server',()=>({syncCostsModuleStatus:async()=>{},syncOrderWorkflowSnapshot:async()=>{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();});afterEach(()=>fixture?.database.close());
function fee(direction:string,amount=100){fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,currency,exchange_rate,amount,stage,counterparty_name,created_at,updated_at) VALUES(?,'org','order',?,'FREIGHT','运费','CNY',1,?,'estimated','测试往来',?,?)").run(`fee:${direction}`,direction,amount,fixture.now,fixture.now);}
function exported(){fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now,fixture.now);}
describe("meeting workflow integrated against all real migrations",()=>{
  it('atomically links planned costs and rolls back the entire allocation if any child payable is already locked',async()=>{
    const sql=fixture.database,now=fixture.now;
    sql.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('warehouse','org','WH','国内仓',?,?)").run(now,now);
    sql.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','warehouse','Z','收货区',?,?)").run(now,now);
    sql.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('location','org','warehouse','zone','L','库位',?,?)").run(now,now);
    sql.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,created_at,updated_at) VALUES('shipment','org','SHIP-TEST','order','customer',?,?)").run(now,now);
    sql.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,cargo_complete,received_at,created_at,updated_at) VALUES('receipt','org','IN-TEST','shipment','warehouse','location',1,?,?,?)").run(now,now,now);
    sql.prepare("INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,warehouse_id,approval_status,approved_by_user_id,created_at,updated_at) VALUES('batch','org','order','PZ-TEST','配载','国内仓','境外仓','warehouse','draft','supervisor',?,?)").run(now,now);
    sql.prepare("INSERT INTO loading_planning_submissions(organization_id,actor_user_id,request_id,payload_hash,batch_id,result_json,created_at,updated_at) VALUES('org','supervisor','plan-00001','hash','batch','{}',?,?)").run(now,now);
    sql.prepare("INSERT INTO warehouse_packing_jobs(id,organization_id,warehouse_id,order_id,shipment_id,transport_batch_id,packing_mode,source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,status,created_at,updated_at) VALUES('job','org','warehouse','order','shipment','batch','preserve',1,1,100,1,'allocated',?,?)").run(now,now);
    sql.prepare("INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,created_at,updated_at) VALUES('mount','org','batch','order',?,?)").run(now,now);
    sql.prepare("INSERT INTO transport_cost_allocations(id,organization_id,batch_id,charge_code,charge_name,counterparty_name,total_amount,allocation_method,density_result,created_by_user_id,creation_mode,created_at,updated_at) VALUES('allocation','org','batch','OVERSEAS_TRANSPORT','境外运输费','供应商',60,'weight','实重','supervisor','planning',?,?)").run(now,now);
    fixture.database.prepare("INSERT INTO transport_cost_allocation_lines(id,organization_id,allocation_id,order_id,final_amount,created_at,updated_at) VALUES('line','org','allocation','order',60,?,?)").run(fixture.now,fixture.now);
    const input={organizationId:'org',allocationId:'allocation',actorUserId:'supervisor',currency:'CNY',exchangeRate:1,counterparty:'供应商',now:fixture.now,lines:[{id:'line',orderId:'order',amount:60}]};
    fixture.database.exec("INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,confirmed,updated_at) VALUES('org','order','payable',1,'now')");
    await expect(fixture.db.batch(plannedCostIntegrationStatements(fixture.db,input))).rejects.toThrow('NOT NULL');
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM business_expenses').get()?.n).toBe(0);
    expect(fixture.database.prepare('SELECT status FROM transport_cost_allocations').get()?.status).toBe('draft');
    fixture.database.exec('DELETE FROM order_expense_direction_controls');await fixture.db.batch(plannedCostIntegrationStatements(fixture.db,input));
    expect(fixture.database.prepare('SELECT stage,amount,source_type FROM business_expenses').get()).toMatchObject({stage:'estimated',amount:60,source_type:'loading_cost_allocation_line'});
    expect(fixture.database.prepare('SELECT status FROM transport_cost_allocations').get()?.status).toBe('confirmed');
  });
  it('uses current/future frozen rules while leaving passed nodes historical, including an entirely hidden approval chain',async()=>{
    fee('receivable');exported();seedFrozenMeetingWorkflow(fixture);
    fixture.database.exec("UPDATE workflow_instance_fields SET is_active=0 WHERE step_key='reconciliation'");
    const state=await loadMeetingSettlement(fixture.db,'org','order');expect(state.fields.every(f=>!f.isActive)).toBe(true);
    expect((await loadMeetingWorkOverview(fixture.db,fixture.actors.get('sales')!)).signatures).toBe(1);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM workflow_instance_fields WHERE step_key='order_creation' AND is_active=1").get()?.n).toBe(3);
    await submitMeetingSignature(fixture.db,{current:fixture.actors.get('sales')!,orderId:'order',direction:'receivable',action:'confirm',notes:'配置无需审批链，明确确认费用',refresh:async()=>{}});
    expect(fixture.database.prepare('SELECT stage FROM business_expenses').get()?.stage).toBe('confirmed');
    fixture.database.exec("UPDATE workflow_instance_step_states SET status='completed' WHERE step_key='reconciliation';UPDATE workflow_instance_fields SET is_active=1 WHERE step_key='reconciliation';DELETE FROM order_expense_direction_controls");
    await expect(assertMeetingSignoffsComplete(fixture.db,'org',['order'],'receivable')).resolves.toBeUndefined();
    expect((await loadMeetingSettlement(fixture.db,'org','order')).open).toBe(false);
  });
  it('fails closed for a corrupt frozen binding instead of treating it as a legacy order',async()=>{
    fee('receivable');exported();seedFrozenMeetingWorkflow(fixture);fixture.database.exec("UPDATE workflow_instances SET current_step_key='missing'");
    await expect(submitMeetingSignature(fixture.db,{current:fixture.actors.get('sales')!,orderId:'order',direction:'receivable',action:'confirm',notes:'',refresh:async()=>{}})).rejects.toThrow('当前仅可查看');
  });
  it('does not invent mandatory signatures for a deliberately empty frozen costs placement',async()=>{
    fee('receivable');exported();seedFrozenMeetingWorkflow(fixture);fixture.database.exec("DELETE FROM workflow_instance_fields WHERE step_key='reconciliation'");
    await expect(submitMeetingSignature(fixture.db,{current:fixture.actors.get('sales')!,orderId:'order',direction:'receivable',action:'confirm',notes:'',refresh:async()=>{}})).resolves.toBeDefined();
    expect(fixture.database.prepare('SELECT stage FROM business_expenses').get()?.stage).toBe('confirmed');
  });
  it('prevents duplicate and over-budget payments and commits cash allocations with balance reservations',async()=>{
    fee('payable');exported();fixture.database.exec("UPDATE business_expenses SET stage='confirmed';INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,confirmed,business_reviewed,finance_reviewed,updated_at) VALUES('org','order','payable',1,1,1,'now')");
    fixture.database.prepare("INSERT INTO order_payable_offline_approvals VALUES('approval','org','order','经理',?,'proof','finance',?)").run(fixture.now,fixture.now);
    fixture.database.prepare("INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,settlement_entity,currency,total_amount,status,created_by_user_id,created_at,updated_at) VALUES('r','org','AP-TEST','payable','测试往来','公司','CNY',100,'confirmed','finance',?,?)").run(fixture.now,fixture.now);
    fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('l','org','r','fee:payable',100,?)").run(fixture.now);
    const input={organizationId:'org',direction:'payment' as const,counterpartyName:'测试往来',currency:'CNY',amount:60,occurredOn:'2026-09-20',settlementEntity:'公司',accountName:'银行',handledByUserId:'cashier',paymentStatementNumber:'AP-TEST',userId:'cashier',now:fixture.now,requestId:'payment-request-00001',assertCanMutate:async()=>{}};
    const paid=await recordCashTransaction(fixture.db,input);expect(await recordCashTransaction(fixture.db,input)).toEqual(paid);
    await expect(recordCashTransaction(fixture.db,{...input,amount:61})).rejects.toThrow('内容不同');
    await expect(recordCashTransaction(fixture.db,{...input,requestId:'payment-request-00002',amount:50})).rejects.toThrow('超过');
    const allocation={organizationId:'org',transactionId:paid.id,reconciliationId:'r',amount:60,userId:'cashier',now:fixture.now,requestId:'allocation-request-00001',assertCanMutate:async()=>{}};
    await allocateCashTransaction(fixture.db,allocation);await allocateCashTransaction(fixture.db,allocation);
    await expect(allocateCashTransaction(fixture.db,{...allocation,amount:59})).rejects.toThrow('内容不同');
    await expect(allocateCashTransaction(fixture.db,{...allocation,requestId:'allocation-request-00002'})).rejects.toThrow('余额');
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM settlement_cash_allocations').get()?.n).toBe(1);
    expect(fixture.database.prepare('SELECT payment_reserved_amount FROM settlement_reconciliations').get()?.payment_reserved_amount).toBe(60);
    expect(fixture.database.prepare('SELECT cash_reserved_amount FROM business_expenses').get()?.cash_reserved_amount).toBe(60);
    expect((await loadMeetingWorkOverview(fixture.db,fixture.actors.get('cashier')!)).items).toContainEqual({title:'出纳待付款：AP-TEST',href:'/admin/billing?tab=cash&q=AP-TEST'});
  });
  it('sends deduplicated SLA alerts to sales and operation and respects hot disable',async()=>{
    fixture.database.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,estimated_delivery_at,created_at,updated_at) VALUES('ship','org','SHIP-TEST','order','customer','in_transit',?,?,?)").run('2026-09-15',fixture.now,fixture.now);
    expect(await refreshTrackingAlerts(fixture.db,'org',new Date('2026-10-04'))).toEqual({created:2});
    expect(await refreshTrackingAlerts(fixture.db,'org',new Date('2026-10-04'))).toEqual({created:0});
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','tracking.alerts_enabled','0',?)").run(fixture.now);
    expect(await refreshTrackingAlerts(fixture.db,'org',new Date('2026-10-05'))).toEqual({created:0});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM internal_notifications WHERE category='tracking_sla'").get()?.n).toBe(2);
  });
  it('returns real role worklists without granting the next role or exposing amounts',async()=>{
    fee('receivable');exported();const sales=fixture.actors.get('sales')!,op=fixture.actors.get('operation')!;
    expect((await loadMeetingWorkOverview(fixture.db,sales)).signatures).toBe(1);
    expect((await loadMeetingWorkOverview(fixture.db,op)).signatures).toBe(0);
    await submitMeetingSignature(fixture.db,{current:sales,orderId:'order',direction:'receivable',action:'confirm',notes:'',refresh:async()=>{}});
    expect((await loadMeetingWorkOverview(fixture.db,sales)).signatures).toBe(0);
    expect((await loadMeetingWorkOverview(fixture.db,op)).signatures).toBe(1);
    expect((await loadMeetingWorkOverview(fixture.db,fixture.actors.get('cashier')!)).payments).toBe(0);
  });
  it("requires export, exact person and sequential AR signatures; never advances transport",async()=>{
    fee("receivable");const input={current:fixture.actors.get("sales")!,orderId:"order",direction:"receivable" as const,action:"confirm" as const,notes:"",refresh:async()=>{}};
    await expect(submitMeetingSignature(fixture.db,input)).rejects.toThrow("实际出境");exported();
    await expect(submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("supervisor")!,action:"finance_review"})).rejects.toThrow("前序");
    const csState=await loadMeetingSettlement(fixture.db,"org","order");
    expect(meetingSignatureAccess(csState,fixture.actors.get("cs")!,"receivable","confirm")).toBeNull();
    await submitMeetingSignature(fixture.db,input);
    await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("operation")!,action:"business_review"});
    expect(fixture.database.prepare("SELECT stage FROM business_expenses").get()?.stage).toBe("estimated");
    await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("supervisor")!,action:"finance_review"});
    expect(fixture.database.prepare("SELECT stage FROM business_expenses").get()?.stage).toBe("confirmed");
    expect((await loadMeetingSettlement(fixture.db,"org","order")).order.status).toBe("in_execution");
  });
  it("requires all AP approvals plus recorded offline approval before payment",async()=>{
    fee("payable");exported();const input={current:fixture.actors.get("operation")!,orderId:"order",direction:"payable" as const,action:"confirm" as const,notes:"",refresh:async()=>{}};
    await submitMeetingSignature(fixture.db,input);await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("supervisor")!,action:"business_review"});
    await expect(assertMeetingSignoffsComplete(fixture.db,"org",["order"],"payable",true)).rejects.toThrow("必办签核");
    await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("finance")!,action:"finance_review"});
    await expect(assertMeetingSignoffsComplete(fixture.db,"org",["order"],"payable",true)).rejects.toThrow("线下审批");
    fixture.database.prepare("INSERT INTO order_payable_offline_approvals VALUES('approval','org','order','总经理',?,'proof','finance',?)").run(fixture.now,fixture.now);
    await expect(assertMeetingSignoffsComplete(fixture.db,"org",["order"],"payable",true)).resolves.toBeUndefined();
  });
  it("retains optimistic commission history and filters partial collections out of HR reports",async()=>{
    fee("receivable");fixture.database.exec("UPDATE business_expenses SET stage='confirmed'");
    const input={current:fixture.actors.get("hr")!,orderId:"order",amount:10,status:"pending",paidOn:"",notes:"人工核算",revision:0};
    await expect(saveCommission(fixture.db,input)).rejects.toThrow('全部实际回款');
    const received=await recordCashTransaction(fixture.db,{organizationId:'org',direction:'receipt',counterpartyName:'测试往来',currency:'CNY',amount:100,occurredOn:'2026-09-20',settlementEntity:'公司',accountName:'银行',handledByUserId:'cashier',userId:'cashier',now:fixture.now,requestId:'receipt-request-00001',assertCanMutate:async()=>{}});
    fixture.database.prepare("INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,settlement_entity,currency,total_amount,status,created_by_user_id,created_at,updated_at) VALUES('r','org','AR-TEST','receivable','测试往来','公司','CNY',100,'confirmed','cs',?,?)").run(fixture.now,fixture.now);
    fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('l','org','r','fee:receivable',100,?)").run(fixture.now);
    const allocation={organizationId:'org',transactionId:received.id,reconciliationId:'r',amount:50,userId:'cashier',now:fixture.now,requestId:'allocation-hr-00001',assertCanMutate:async()=>{}};
    await allocateCashTransaction(fixture.db,allocation);await allocateCashTransaction(fixture.db,allocation);
    expect(await loadHrReport(fixture.db,input.current,"2026-09-01","2026-09-30")).toEqual([]);
    await expect(saveCommission(fixture.db,input)).rejects.toThrow('全部实际回款');
    await allocateCashTransaction(fixture.db,{...allocation,requestId:'allocation-hr-00002'});
    await saveCommission(fixture.db,input);await saveCommission(fixture.db,{...input,amount:20,revision:1});
    await expect(saveCommission(fixture.db,{...input,revision:1})).rejects.toThrow("其他人修改");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_commission_history").get()?.n).toBe(2);
    expect(await loadHrReport(fixture.db,input.current,"2026-09-01","2026-09-30")).toHaveLength(1);
    expect(await generateScheduledHrReports(fixture.db,"org",new Date("2026-10-04"))).toEqual({created:2});
    expect(await generateScheduledHrReports(fixture.db,"org",new Date("2026-10-04"))).toEqual({created:0});
  });
  it("creates one dispatch task and deduplicated notices, then validates supplier-linked resources",async()=>{
    fee("receivable");const current=fixture.actors.get("operation")!;
    fixture.database.exec("UPDATE transport_orders SET business_type='ftl' WHERE id='order'");
    const request={current,orderId:"order",plannedPortArrivalAt:"2026-10-05T00:00:00Z"};
    expect((await requestDispatchTask(fixture.db,request)).created).toBe(true);expect((await requestDispatchTask(fixture.db,request)).created).toBe(false);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM internal_notifications WHERE category='dispatch_request'").get()?.n).toBe(1);
    await expect(fulfillDispatchTask(fixture.db,{current:fixture.actors.get("commercial")!,orderId:"order",carrierId:"missing",vehicleId:"missing",driverId:"missing",freightAmount:10,currency:"CNY",exchangeRate:1,notes:""})).rejects.toThrow("同一有效运输资源");
    expect(await refreshAutomaticDispatchTasks(fixture.db,"org")).toEqual({created:0,skipped:0});
  });
});
