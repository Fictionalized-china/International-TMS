import { describe, expect, it } from "vitest";
import { ordinaryOrderBatchExclusionSql } from "./batch-order-list";

describe("ordinary order list PZ exclusion",()=>{
  it("keeps active mounted orders inside the unified PZ workspace",()=>{
    const sql=ordinaryOrderBatchExclusionSql("orders");
    expect(sql).toContain("ordinary_batch_order.order_id=orders.id");
    expect(sql).toContain("ordinary_batch.batch_number LIKE 'PZ-%'");
    expect(sql).toContain("ordinary_batch_order.status!='removed'");
    expect(sql).toContain("ordinary_batch.status!='cancelled'");
    expect(sql).toContain("'overseas_arrived','waiting_pickup','pickup_completed'");
  });
});
