import {describe,it,expect,vi} from "vitest";
const harness=vi.hoisted(()=>({user:{userId:"operator",organizationId:"org",permissions:["order.view"]},access:vi.fn(async()=>({id:"order"}))}));
vi.mock("../lib/auth.server",()=>({requireSessionUser:async()=>harness.user}));
vi.mock("../lib/order-access.server",()=>({requireOrderAccess:harness.access}));
import {loader,action} from "./admin.order-operations";
describe("retired order operations authorization",()=>{
  it("preserves the authenticated tab on direct compatibility navigation",async()=>{
    const tab="current-session-tab";
    const response=await loader({request:new Request(`https://tms.test/admin/orders/order/operations?itmsTab=${tab}`),params:{orderId:"order"}} as Parameters<typeof loader>[0]);
    expect(response.headers.get("Location")).toBe(`/admin/orders/order?itmsTab=${tab}`);
  });
  it("redirects to the guarded order detail without returning amounts",async()=>{
    const response=await loader({request:new Request("http://localhost/admin/orders/order/operations"),params:{orderId:"order"}} as Parameters<typeof loader>[0]);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin/orders/order");
    expect(await response.text()).toBe("");
    expect(harness.access).toHaveBeenCalledWith(harness.user,"order");
  });
  it("refuses old mutation requests",async()=>{
    await expect(action({request:new Request("http://localhost/admin/orders/order/operations",{method:"POST",body:new URLSearchParams({intent:"cargo"})}),params:{orderId:"order"}} as Parameters<typeof action>[0])).rejects.toMatchObject({status:405});
  });
});
