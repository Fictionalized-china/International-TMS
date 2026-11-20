import{afterEach,describe,expect,it,vi}from'vitest';
import{meetingFixture}from'./meeting-integration-fixture';
import{saveOrderCargoItem}from'./order-cargo-editor.server';
vi.mock('cloudflare:workers',()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
afterEach(()=>fixture?.database.close());
describe('cargo edits preserve independent declared quantities',()=>{
  it.each([[10,10],[2,2]])('preserves saved declared %s while keeping packaging totals independent',async(declared,expected)=>{
    fixture=await meetingFixture();
    fixture.database.exec("UPDATE transport_orders SET status='draft',declared_quantity_unit='台' WHERE id='order'");
    fixture.database.prepare("INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,volume_per_package_cbm,declared_quantity,declared_unit,created_at,updated_at) VALUES('cargo','org','order',1,'设备','carton',2,1,10,0,?,'台',?,?)").run(declared,fixture.now,fixture.now);
    const form=new FormData();for(const[key,value]of Object.entries({cargoItemId:'cargo',cargoName:'设备',packageType:'carton',packageCount:'2',piecesPerPackage:'1',weight:'20',volume:'0',currency:'CNY'}))form.set(key,value);
    form.set('cargoRequestKey',crypto.randomUUID());form.set('cargoOrderVersion',fixture.now);
    const input={db:fixture.db,organizationId:'org',orderId:'order',orderNumber:'TEST-SO',actorUserId:'owner',mode:'update' as const,form,workflowFields:[]};
    expect(await saveOrderCargoItem(input)).toMatchObject({ok:true,created:false});
    expect(fixture.database.prepare("SELECT pieces,planned_inbound_package_count,gross_weight_kg,volume_cbm FROM transport_orders WHERE id='order'").get()).toEqual({pieces:expected,planned_inbound_package_count:2,gross_weight_kg:40,volume_cbm:0});
    expect(fixture.database.prepare("SELECT declared_quantity,declared_unit FROM order_cargo_items WHERE id='cargo'").get()).toEqual({declared_quantity:declared,declared_unit:'台'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_cargo_packages WHERE order_id='order'").get()).toEqual({n:2});
    expect(await saveOrderCargoItem(input)).toMatchObject({ok:true});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_cargo_packages WHERE order_id='order'").get()).toEqual({n:2});
    form.delete('cargoItemId');form.set('piecesPerPackage','3');
    form.set('cargoRequestKey',crypto.randomUUID());form.set('cargoOrderVersion',String(fixture.database.prepare("SELECT updated_at FROM transport_orders WHERE id='order'").get()?.updated_at));
    expect(await saveOrderCargoItem({...input,mode:'create'})).toMatchObject({ok:true,created:true});
    expect(fixture.database.prepare("SELECT declared_quantity,declared_unit FROM order_cargo_items WHERE id!='cargo'").get()).toEqual({declared_quantity:6,declared_unit:'台'});
    expect(fixture.database.prepare("SELECT pieces,planned_inbound_package_count FROM transport_orders WHERE id='order'").get()).toEqual({pieces:expected+6,planned_inbound_package_count:4});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_cargo_packages WHERE order_id='order'").get()).toEqual({n:4});
  });
});
