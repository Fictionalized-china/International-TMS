import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { meetingFixture } from "../lib/meeting-integration-fixture";
import { scanInboundMarkAtWarehouse } from "../lib/warehouse-inbound-scan-session.server";
const state=vi.hoisted(()=>({env:{} as {DB:D1Database},actor:{} as object,progress:vi.fn()}));
vi.mock("cloudflare:workers",()=>({env:state.env}));
vi.mock("../lib/auth.server",()=>({requireSessionUser:async()=>state.actor}));
vi.mock("../lib/warehouse-context.server",()=>({loadWarehouseContext:async()=>({selected:{id:"wh",warehouse_role:"domestic_collection"},selectedAccessLevel:"operator"})}));
vi.mock("../lib/warehouse-access.server",()=>({requireWarehouseAssignment:async()=>undefined}));
vi.mock("../lib/warehouse-progress.server",()=>({recordWarehouseProgress:state.progress}));
vi.mock("../lib/business-workflow.server",()=>({recordWorkflowEvent:async()=>undefined}));
vi.mock("../lib/order-modules.server",()=>({syncOrderWorkflowSnapshot:async()=>undefined}));
import { action } from "./warehouse.acceptance";

let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  fixture=await meetingFixture();state.env.DB=fixture.db;state.actor=fixture.actors.get("owner")!;state.progress.mockReset();
  const sql=fixture.database,now=fixture.now;
  sql.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('wh','org','WH','国内仓',?,?)").run(now,now);
  sql.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','wh','Z','收货区',?,?)").run(now,now);
  sql.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('loc','org','wh','zone','L','收货位',?,?)").run(now,now);
  sql.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,created_at,updated_at) VALUES('shipment','org','SHP-TEST','order','customer','picked_up',?,?)").run(now,now);
  sql.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,destination_warehouse_id,created_at,updated_at) VALUES('assignment','org','order','first_mile','wh',?,?)").run(now,now);
  sql.exec("UPDATE transport_orders SET planned_inbound_package_count=3 WHERE id='order'");
  sql.prepare("INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,volume_per_package_cbm,created_at,updated_at) VALUES('cargo','org','order',1,'设备','carton',3,1,10,1,?,?)").run(now,now);
  for(let i=1;i<=3;i++)sql.prepare("INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,status,created_at) VALUES(?,'org','order','cargo',?,?,'planned',?)").run(`mark${i}`,`TEST-SO-IN-00${i}`,i,now);
});
afterEach(()=>fixture?.database.close());
async function scan(index:number){return scanInboundMarkAtWarehouse(fixture.db,{organizationId:"org",warehouseId:"wh",userId:"owner",code:`TEST-SO-IN-00${index}`,requestKey:crypto.randomUUID()});}
function request(result="partial",weight="10"){
  const session=fixture.database.prepare("SELECT id FROM warehouse_inbound_order_receiving_sessions WHERE status='scanning'").get()!;
  const codes=fixture.database.prepare("SELECT m.package_code FROM warehouse_inbound_order_receiving_items i JOIN order_cargo_packages m ON m.id=i.inbound_mark_id WHERE i.order_receiving_session_id=?").all(session.id as string).map(row=>String(row.package_code)).sort();
  return new Request("http://local.test/warehouse/acceptance?warehouseId=wh",{method:"POST",body:new URLSearchParams({orderId:"order",locationId:"loc",receiptResult:result,actualWeight_0:weight,receivingSessionId:String(session.id),scannedPackageCodes:codes.join("|")})});
}
async function receive(req=request()){return action({request:req,params:{},context:undefined} as never);}
const count=(table:string)=>Number(fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
describe("domestic partial receipts through the real action and inventory transaction",()=>{
  it("does not turn historical unmeasured stock into a weight shortage when the next arrival is weighed",async()=>{
    await scan(1);await receive();
    fixture.database.exec("UPDATE warehouse_receipt_items SET actual_weight_kg=0; UPDATE warehouse_receipts SET total_weight_kg=0; UPDATE warehouse_packages SET weight_kg=NULL");
    await scan(2);await scan(3);expect(await receive(request("ready","20"))).toBeInstanceOf(Response);
    expect(count("warehouse_receipt_differences")).toBe(0);
    expect(fixture.database.prepare("SELECT SUM(total_weight_kg) n FROM warehouse_receipts").get()?.n).toBe(20);
  });
  it("keeps physical receipt committed and a durable retry when projection fails, without another stock write",async()=>{
    state.progress.mockRejectedValueOnce(new Error("temporary projection failure"));await scan(1);
    const response=await receive();expect(response).toBeInstanceOf(Response);expect((response as Response).headers.get("Location")).toContain("syncPending=1");
    expect(count("warehouse_receipts")).toBe(1);expect(count("warehouse_packages")).toBe(1);
    const job=fixture.database.prepare("SELECT status,last_error FROM physical_operation_sync_jobs").get();expect(job).toMatchObject({status:"pending",last_error:"temporary projection failure"});
  });
  it("rolls back receipt, stock and scan confirmation if the mandatory physical audit cannot be saved",async()=>{
    await scan(1);fixture.database.exec("CREATE TRIGGER reject_receipt_audit BEFORE INSERT ON audit_logs WHEN NEW.action='warehouse.acceptance.receive' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END");
    const error=vi.spyOn(console,"error").mockImplementation(()=>{});
    expect(await receive()).toMatchObject({formError:expect.stringContaining("未写入库存")});
    expect(count("warehouse_receipts")).toBe(0);expect(count("warehouse_packages")).toBe(0);
    expect(fixture.database.prepare("SELECT status FROM warehouse_inbound_order_receiving_sessions").get()?.status).toBe("scanning");
    expect(fixture.database.prepare("SELECT status FROM order_cargo_packages WHERE id='mark1'").get()?.status).toBe("planned");error.mockRestore();
  });
  it("stores an optional photo with the actual receipt, package, event and customer in one transaction",async()=>{
    await scan(1);const plain=request(),form=await plain.formData();
    const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCej5DwADXAHwCt6haAAAAABJRU5ErkJggg=="),c=>c.charCodeAt(0));
    form.append("sitePhotos",new File([bytes],"到货.png",{type:"image/png"}));form.append("sitePhotoThumbnails",new File([bytes],"预览.png",{type:"image/png"}));
    expect(await receive(new Request(plain.url,{method:"POST",body:form}))).toBeInstanceOf(Response);
    expect(count("warehouse_packages")).toBe(1);expect(count("order_site_photos")).toBe(1);
    const photo=fixture.database.prepare("SELECT p.event_id,p.source_id,p.package_ids_json,a.customer_id FROM order_site_photos p JOIN order_attachments a ON a.id=p.attachment_id").get()!;
    expect(photo.source_id).toBe(fixture.database.prepare("SELECT id FROM warehouse_receipts").get()?.id);
    expect(photo.event_id).toBe(fixture.database.prepare("SELECT id FROM shipment_events").get()?.id);
    expect(JSON.parse(String(photo.package_ids_json))).toEqual([fixture.database.prepare("SELECT id FROM warehouse_packages").get()?.id]);
    expect(photo.customer_id).toBe("customer");
  });
  it("keeps scanned marks pending when a required photo is absent and succeeds on the same session after reselecting",async()=>{
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','photos.required_stages','domestic_receipt',?)").run(fixture.now);
    await scan(1);const error=vi.spyOn(console,"error").mockImplementation(()=>{});
    expect(await receive()).toMatchObject({formError:expect.stringContaining("必须上传现场照片")});
    expect(count("warehouse_packages")).toBe(0);expect(count("warehouse_receipts")).toBe(0);
    expect(fixture.database.prepare("SELECT status FROM warehouse_inbound_order_receiving_sessions").get()?.status).toBe("scanning");
    fixture.database.exec("DELETE FROM business_process_policies");
    expect(await receive()).toBeInstanceOf(Response);error.mockRestore();
  });
  it("receives 1 then 2 packages, accumulates weight, and only completes the warehouse at the end",async()=>{
    await scan(1);const stale=request();expect(await receive()).toBeInstanceOf(Response);
    expect(count("warehouse_packages")).toBe(1);expect(count("warehouse_receipt_differences")).toBe(0);
    expect(state.progress).toHaveBeenLastCalledWith(expect.objectContaining({stepCode:"receiving"}));
    expect(fixture.database.prepare("SELECT status FROM order_cargo_packages WHERE id='mark2'").get()?.status).toBe("planned");
    expect(await receive(stale)).toMatchObject({formError:expect.stringContaining("扫码记录")});
    expect(count("warehouse_receipts")).toBe(1);
    await scan(2);await scan(3);expect(await receive(request("ready","20"))).toBeInstanceOf(Response);
    expect(count("warehouse_packages")).toBe(3);expect(count("warehouse_receipt_differences")).toBe(0);
    expect(fixture.database.prepare("SELECT SUM(total_weight_kg) weight,SUM(total_packages) packages FROM warehouse_receipts").get()).toEqual({weight:30,packages:3});
    expect(state.progress).toHaveBeenLastCalledWith(expect.objectContaining({stepCode:"ready"}));
    expect((await scan(1)).outcome).toBe("duplicate");
  });
  it("refuses stale scan contents instead of distributing one-package weight across two newly scanned packages",async()=>{
    await scan(1);const stale=request();await scan(2);
    expect(await receive(stale)).toMatchObject({formError:expect.stringContaining("扫描包裹已变化")});
    expect(count("warehouse_receipts")).toBe(0);
  });
  it("still refuses a real partial-arrival weight discrepancy and premature ready",async()=>{
    await scan(1);
    expect(await receive(request("partial","20"))).toMatchObject({formError:expect.stringContaining("差异")});
    expect(await receive(request("ready","10"))).toMatchObject({formError:expect.stringContaining("不能直接确认货齐")});
    expect(count("warehouse_packages")).toBe(0);
  });
  it("rolls back every inventory fact if another receiver confirms the same session before this transaction",async()=>{
    await scan(1);const original=fixture.db.batch.bind(fixture.db);
    fixture.db.batch=async statements=>{fixture.database.exec("UPDATE warehouse_inbound_order_receiving_sessions SET status='cancelled' WHERE status='scanning'");return original(statements);};
    const error=vi.spyOn(console,"error").mockImplementation(()=>{});
    expect(await receive()).toMatchObject({formError:expect.stringContaining("未写入库存")});
    expect(count("warehouse_packages")).toBe(0);expect(count("warehouse_receipts")).toBe(0);
    expect(fixture.database.prepare("SELECT status FROM order_cargo_packages WHERE id='mark1'").get()?.status).toBe("planned");
    error.mockRestore();
  });
});
