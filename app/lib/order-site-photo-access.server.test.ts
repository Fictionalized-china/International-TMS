import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {meetingFixture} from "./meeting-integration-fixture";
import type {SessionUser} from "./auth.server";
const state=vi.hoisted(()=>({env:{} as {DB:D1Database},actor:{} as SessionUser,customer:"customer",warehouse:"wh"}));
vi.mock("cloudflare:workers",()=>({env:state.env}));
vi.mock("./auth.server",()=>({requireSessionUser:async()=>state.actor}));
vi.mock("./portal.server",()=>({requirePortalCustomer:async()=>({user:state.actor,customer:{id:state.customer}})}));
vi.mock("./warehouse-context.server",()=>({loadWarehouseContext:async()=>({selected:{id:state.warehouse,warehouse_role:"domestic_collection"}})}));
vi.mock("./warehouse-access.server",()=>({requireWarehouseAssignment:async()=>undefined}));
import {loadSitePhotoFile,loadSitePhotoPanel,uploadSitePhotoSupplement} from "./order-site-photo-access.server";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
const pixel="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCej5DwADXAHwCt6haAAAAABJRU5ErkJggg==";
function post(key="photo-request-one",description="到货外观"){
  const form=new FormData(),file=new File([Uint8Array.from(atob(pixel),c=>c.charCodeAt(0))],"到货.png",{type:"image/png"});
  form.set("stage","domestic_receipt");form.set("description",description);form.set("photoRequestKey",key);form.append("sitePhotos",file);form.append("sitePhotoThumbnails",file);
  return new Request("http://test.local/admin/order-site-photos/order",{method:"POST",body:form});
}
const get=(search="")=>new Request(`http://test.local/photos${search}`);
beforeEach(async()=>{
  fixture=await meetingFixture();state.env.DB=fixture.db;state.actor=fixture.actors.get("owner")!;state.customer="customer";state.warehouse="wh";
  fixture.database.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('wh','org','WH','国内仓',?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,destination_warehouse_id,created_at,updated_at) VALUES('first','org','order','first_mile','wh',?,?)").run(fixture.now,fixture.now);
});
afterEach(()=>fixture?.database.close());
describe("site photos normal handler scopes and customer originals",()=>{
  it("reads historical exception images without duplicating originals, loading them as thumbnails or sharing internal descriptions",async()=>{
    const s=fixture.database,n=fixture.now;
    s.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','wh','Z','到货',?,?)").run(n,n);
    s.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('loc','org','wh','zone','L','收货位',?,?)").run(n,n);
    s.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,created_at,updated_at) VALUES('shipment','org','SHP-PHOTO','order','customer','picked_up',?,?)").run(n,n);
    s.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,received_by_user_id,received_at,created_at,updated_at) VALUES('receipt','org','IN-PHOTO','shipment','wh','loc','completed','owner',?,?,?)").run(n,n,n);
    s.prepare("INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,status,created_at,updated_at) VALUES('pkg','org','receipt','shipment','wh','loc','PKG-PHOTO','PKG-PHOTO',1,'exception',?,?)").run(n,n);
    s.prepare("INSERT INTO warehouse_exceptions(id,organization_id,exception_number,package_id,shipment_id,exception_type,severity,status,previous_package_status,description,reported_by_user_id,reported_at,created_at,updated_at) VALUES('exception','org','EX-TEST','pkg','shipment','damage','medium','open','in_stock','内部责任讨论，不向客户公开','owner',?,?,?)").run(n,n,n);
    s.prepare("INSERT INTO warehouse_exception_attachments(id,organization_id,exception_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,created_at) VALUES('legacy-photo','org','exception','现场.png','image/png',73,?,'owner',?)").run(`data:image/png;base64,${pixel}`,n);
    const panel=await loadSitePhotoPanel(get(),"admin","order");
    expect(panel.photos).toContainEqual(expect.objectContaining({id:"exception:legacy-photo",has_thumbnail:0,description:"历史仓库现场凭证"}));
    expect(JSON.stringify(panel)).not.toContain("内部责任讨论");expect(JSON.stringify(panel)).not.toContain("base64");
    expect(await loadSitePhotoFile(get(),"portal","exception:legacy-photo")).toBeInstanceOf(Response);
    await expect(loadSitePhotoFile(get("?size=thumbnail"),"portal","exception:legacy-photo")).rejects.toMatchObject({status:404});
    state.customer="other";await expect(loadSitePhotoFile(get(),"portal","exception:legacy-photo")).rejects.toMatchObject({status:404});
    expect(s.prepare("SELECT COUNT(*) n FROM order_attachments").get()?.n).toBe(0);
  });
  it("keeps company-wide tracking read access separate from this order's photo-upload duty",async()=>{
    state.actor=fixture.actors.get("tracker")!;
    expect(state.actor.permissions).toContain("tracking.daily.manage");
    const request=post(),form=await request.formData();form.set("stage","pickup");
    await expect(uploadSitePhotoSupplement(new Request(request.url,{method:"POST",body:form}),"admin","order")).rejects.toMatchObject({status:404});
    expect((await loadSitePhotoPanel(get(),"admin","order")).stages).toEqual([]);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_attachments").get()?.n).toBe(0);
  });
  it("allows the actual transport owner and rejects a transfer made before the photo transaction",async()=>{
    state.actor=fixture.actors.get("operation")!;
    const make=async()=>{const request=post("transport-owner-photos"),form=await request.formData();form.set("stage","pickup");return new Request(request.url,{method:"POST",body:form});};
    expect(await uploadSitePhotoSupplement(await make(),"admin","order")).toMatchObject({success:expect.any(String)});
    const original=fixture.db.batch.bind(fixture.db);
    fixture.db.batch=async statements=>{fixture.database.exec("UPDATE order_module_instances SET assignee_user_id='cs' WHERE module_code='transport'");return original(statements);};
    expect(await uploadSitePhotoSupplement(await make(),"admin","order")).toMatchObject({formError:expect.stringContaining("权限")});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_attachments").get()?.n).toBe(1);
  });
  it("uploads once from the order/file center, and permits its customer to open thumbnail and original",async()=>{
    expect(await uploadSitePhotoSupplement(post(),"admin","order")).toMatchObject({success:expect.stringContaining("已保存")});
    expect(await uploadSitePhotoSupplement(post(),"admin","order")).toMatchObject({success:expect.any(String)});
    const panel=await loadSitePhotoPanel(get(),"admin","order"),id=panel.photos[0].id;
    expect(panel.photos).toHaveLength(1);expect(JSON.stringify(panel)).not.toContain("base64");
    for(const search of ["?size=thumbnail","?size=original"]){const response=await loadSitePhotoFile(get(search),"portal",id);expect(response.headers.get("content-type")).toBe("image/png");expect(response.headers.get("cache-control")).toBe("private, no-store");expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(40);}
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).toBe("in_execution");
  });
  it("blocks other customers and unassociated internal files even with a known ID",async()=>{
    await uploadSitePhotoSupplement(post(),"admin","order");const id=(await loadSitePhotoPanel(get(),"admin","order")).photos[0].id;
    state.customer="different-customer";await expect(loadSitePhotoFile(get(),"portal",id)).rejects.toMatchObject({status:404});
    await expect(loadSitePhotoFile(get(),"portal","internal-finance-file")).rejects.toMatchObject({status:404});
    state.customer="customer";
    fixture.database.prepare("INSERT INTO customers(id,organization_id,code,identity_code,name,created_at,updated_at) VALUES('changed-customer','org','NEW','NEW23','新客户',?,?)").run(fixture.now,fixture.now);
    fixture.database.exec("UPDATE transport_orders SET customer_id='changed-customer' WHERE id='order'");state.customer="changed-customer";
    await expect(loadSitePhotoFile(get(),"portal",id)).rejects.toMatchObject({status:404});
    expect((await loadSitePhotoPanel(get(),"admin","order")).photos).toEqual([]);
  });
  it("keeps warehouse file access within the selected physical warehouse",async()=>{
    await uploadSitePhotoSupplement(post(),"admin","order");const id=(await loadSitePhotoPanel(get(),"admin","order")).photos[0].id;
    expect(await loadSitePhotoFile(get(),"warehouse",id)).toBeInstanceOf(Response);
    state.warehouse="unrelated-warehouse";await expect(loadSitePhotoFile(get(),"warehouse",id)).rejects.toMatchObject({status:404});
    await expect(loadSitePhotoPanel(get(),"warehouse","order")).rejects.toMatchObject({status:404});
  });
  it("does not turn HR read access into upload permission or trust a disabled owner session",async()=>{
    state.actor=fixture.actors.get("hr")!;await expect(uploadSitePhotoSupplement(post(),"admin","order")).rejects.toMatchObject({status:403});
    state.actor=fixture.actors.get("owner")!;fixture.database.exec("UPDATE memberships SET status='disabled' WHERE user_id='owner'");
    await expect(uploadSitePhotoSupplement(post(),"admin","order")).rejects.toMatchObject({status:403});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_attachments").get()?.n).toBe(0);
  });
  it("rolls back originals and association if the actor is disabled immediately before submission",async()=>{
    const original=fixture.db.batch.bind(fixture.db);
    fixture.db.batch=async statements=>{fixture.database.exec("UPDATE memberships SET status='disabled' WHERE user_id='owner'");return original(statements);};
    expect(await uploadSitePhotoSupplement(post(),"admin","order")).toMatchObject({formError:expect.stringContaining("权限")});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_attachments").get()?.n).toBe(0);
  });
  it("detects altered retry content instead of quietly appending photos under a reused key",async()=>{
    await uploadSitePhotoSupplement(post(),"admin","order");
    expect(await uploadSitePhotoSupplement(post("photo-request-one","不同内容"),"admin","order")).toMatchObject({formError:expect.any(String)});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_attachments").get()?.n).toBe(1);
  });
});
