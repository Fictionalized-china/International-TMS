import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";
import type { SessionUser } from "./auth.server";

const harness=vi.hoisted(()=>({db:null as unknown as D1Database,ensure:vi.fn(),sync:vi.fn(),documents:vi.fn(),notification:vi.fn()}));
vi.mock("cloudflare:workers",()=>({env:{get DB(){return harness.db;}}}));
vi.mock("./order-modules.server",()=>({ensureOrderModules:harness.ensure,syncOrderWorkflowSnapshot:vi.fn(async()=>{})}));
vi.mock("./batch-transport-sync.server",()=>({synchronizeBatchTransport:harness.sync}));
vi.mock("./loading-manifest.server",()=>({ensureBatchSystemDocuments:harness.documents}));
vi.mock("./internal-notifications.server",()=>({assignedBatchNotificationStatement:harness.notification,warehouseBatchReadyNotificationStatement:harness.notification}));
import { createOperationPlannedBatch,resumeOperationPlannedBatch } from "./loading-batch-planning.server";
import { sha256 } from "./crypto.server";

let database:DatabaseSync;
const current:SessionUser={organizationId:"org",userId:"supervisor",positionCode:"OPERATION_SUPERVISOR",roleCodes:[],permissions:["transport.batch.plan"],
  sessionId:"session",organizationName:"test",email:"supervisor@e2e.test",displayName:"主管",site:"admin",
  departmentId:null,departmentCode:"OP",dataScope:"company",warehouseIds:[],regionCountryCodes:[]};
const result={batchId:"batch",batchNumber:"PZ-TEST",orderIds:["order"],operationSupervisorUserId:"supervisor",
  totalWeight:20,totalVolume:1,receivableBaseAmount:100,costBaseAmount:60,costAllocationId:"cost"};
const request={current,requestId:"request-000000001",orderIds:["order"],batchName:"test",carrierId:"carrier",vehicleId:"vehicle",driverId:"driver",
  borderPort:"",customsLocation:"",plannedLoadingAt:"",plannedDepartureAt:"",plannedArrivalAt:"",routeNotes:"",notes:"",
  operationAssigneeUserId:"operator",documentAssigneeUserId:"doc",costAmount:60,costCurrency:"CNY",costExchangeRate:1,costAllocationMethod:"auto" as const};

beforeEach(async()=>{
  vi.clearAllMocks();harness.ensure.mockResolvedValue(undefined);harness.sync.mockResolvedValue(undefined);harness.documents.mockResolvedValue(true);
  database=new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE transport_batches(id TEXT PRIMARY KEY,organization_id TEXT,status TEXT,batch_number TEXT,
    operation_assignee_user_id TEXT,document_assignee_user_id TEXT,warehouse_id TEXT,created_by_user_id TEXT,approval_status TEXT,updated_at TEXT);
    CREATE TABLE transport_batch_orders(id TEXT PRIMARY KEY,organization_id TEXT,batch_id TEXT,order_id TEXT,status TEXT);
    CREATE TABLE order_module_instances(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,module_code TEXT,enabled INTEGER,
      status TEXT,current_step_code TEXT,current_step_name TEXT,progress_percent INTEGER,started_at TEXT,completed_at TEXT,blocking_reason TEXT,updated_at TEXT);
    CREATE TABLE order_module_history(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,module_instance_id TEXT,action_code TEXT,
      action_name TEXT,from_step_code TEXT,to_step_code TEXT,to_step_name TEXT,actor_user_id TEXT,notes TEXT,occurred_at TEXT);`);
  database.exec(readFileSync(new URL("../../migrations/0167_loading_integrity_and_sync.sql",import.meta.url),"utf8"));
  harness.db=sqliteD1(database);harness.notification.mockImplementation(()=>harness.db.prepare("SELECT 1"));
  database.exec("INSERT INTO transport_batches VALUES('batch','org','planning','PZ-TEST','operator','doc','warehouse','supervisor','draft',NULL)");
  database.exec(`ALTER TABLE transport_batches ADD COLUMN order_id TEXT;
    CREATE TABLE transport_orders(id TEXT PRIMARY KEY,organization_id TEXT,order_number TEXT,customer_id TEXT,business_type TEXT,transport_mode TEXT,
      salesperson_user_id TEXT,quote_commercial_user_id TEXT,quote_commercial_name_snapshot TEXT,origin_country TEXT,origin_state TEXT,origin_city TEXT,
      destination_country TEXT,destination_state TEXT,destination_city TEXT,exit_port TEXT,transit_locations TEXT,customs_location TEXT,domestic_agent TEXT,
      declared_quantity_unit TEXT,intake_operations_json TEXT);
    CREATE TABLE mutation_commit_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL,created_at TEXT);
    INSERT INTO transport_orders(id,organization_id,order_number) VALUES('order','org','LEGACY-SO');
    INSERT INTO transport_batch_orders VALUES('membership','org','batch','order','active');`);
  const {current:_c,requestId:_r,...payload}=request;
  const hash=await sha256(JSON.stringify({...payload,orderIds:[...request.orderIds].sort()}));
  database.prepare("INSERT INTO loading_planning_submissions(organization_id,actor_user_id,request_id,payload_hash,batch_id,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("org","supervisor",request.requestId,hash,"batch",JSON.stringify(result),"now","now");
});
afterEach(()=>database.close());

describe("saved loading plan recovery",()=>{
  it("activates a loading module whose initial step is empty",async()=>{
    database.exec("INSERT INTO order_module_instances(id,organization_id,order_id,module_code,enabled,status,current_step_code) VALUES('module','org','order','loading',1,'pending',NULL)");
    expect(await resumeOperationPlannedBatch(current,"batch")).toMatchObject({syncPending:false});
    expect(database.prepare("SELECT status,current_step_code FROM order_module_instances").get()).toEqual({status:"in_progress",current_step_code:"planned"});
  });
  it("returns the saved batch and leaves execution closed after a synchronization failure",async()=>{
    harness.ensure.mockRejectedValueOnce(new Error("module sync failed"));
    expect(await resumeOperationPlannedBatch(current,"batch")).toMatchObject({batchId:"batch",syncPending:true});
    expect(database.prepare("SELECT approval_status FROM transport_batches").get()).toEqual({approval_status:"draft"});
    expect(database.prepare("SELECT sync_status,sync_token FROM loading_planning_submissions").get()).toEqual({sync_status:"pending",sync_token:null});
    expect(harness.notification).not.toHaveBeenCalled();
    expect(await resumeOperationPlannedBatch(current,"batch")).toMatchObject({batchId:"batch",syncPending:false});
    expect(database.prepare("SELECT approval_status FROM transport_batches").get()).toEqual({approval_status:"draft"});
    expect(harness.notification).not.toHaveBeenCalled();
  });
  it("reuses the same submission without re-running completed synchronization",async()=>{
    expect(await createOperationPlannedBatch(request)).toMatchObject({batchId:"batch",syncPending:false});
    const callCount=harness.sync.mock.calls.length;
    expect(await createOperationPlannedBatch(request)).toMatchObject({batchId:"batch",syncPending:false});
    expect(harness.sync).toHaveBeenCalledTimes(callCount);
    expect(database.prepare("SELECT COUNT(*) total FROM transport_batches").get()).toEqual({total:1});
    await expect(createOperationPlannedBatch({...request,costAmount:61})).rejects.toThrow("不同的规划");
  });
  it("serializes two simultaneous retries",async()=>{
    let release:()=>void=()=>{};
    harness.ensure.mockImplementationOnce(()=>new Promise<void>((resolve)=>{release=resolve;}));
    const first=resumeOperationPlannedBatch(current,"batch");
    await vi.waitFor(()=>expect(harness.ensure).toHaveBeenCalledTimes(1));
    expect(await resumeOperationPlannedBatch(current,"batch")).toMatchObject({syncPending:true});
    release();expect(await first).toMatchObject({syncPending:false});
    expect(harness.sync).toHaveBeenCalledTimes(1);
  });
  it("does not generate documents or advance approved state during initial planning sync",async()=>{
    database.exec("INSERT INTO order_module_instances(id,organization_id,order_id,module_code,enabled,status,current_step_code) VALUES('module','org','order','loading',1,'pending','ready')");
    harness.sync.mockImplementation(async()=>{database.exec("UPDATE order_module_instances SET status='completed',current_step_code='confirmed'");});
    harness.documents.mockRejectedValueOnce(new Error("document write failed"));
    expect(await resumeOperationPlannedBatch(current,"batch")).toMatchObject({syncPending:false});
    expect(database.prepare("SELECT status,current_step_code FROM order_module_instances").get()).toEqual({status:"completed",current_step_code:"confirmed"});
    expect(database.prepare("SELECT COUNT(*) total FROM order_module_history").get()).toEqual({total:1});
    expect(harness.documents).not.toHaveBeenCalled();
  });
  it("rejects a different actor and a cancelled batch",async()=>{
    await expect(resumeOperationPlannedBatch({...current,userId:"other"},"batch")).rejects.toThrow("没有这次");
    database.exec("UPDATE transport_batches SET status='cancelled'");
    await expect(resumeOperationPlannedBatch(current,"batch")).rejects.toThrow("已取消");
    expect(harness.ensure).not.toHaveBeenCalled();
  });
});
