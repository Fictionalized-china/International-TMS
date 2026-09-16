import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("./routes/warehouse.outbound.tsx", import.meta.url), "utf8");

describe("warehouse outbound MySQL query contract", () => {
  it("orders distinct batch orders through a selected aggregate sequence", () => {
    expect(route).toContain("MIN(bo.sequence_no) sequence_no");
    expect(route).toContain("GROUP BY o.id,o.order_number,o.customer_id,c.name");
    expect(route).not.toContain("SELECT DISTINCT o.id order_id,o.order_number,o.customer_id,c.name customer_name");
  });
});
