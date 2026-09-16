import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin loading detail MySQL contract", () => {
  it("does not group the one-row-per-order batch query", () => {
    const route = readFileSync(
      new URL("./routes/admin.loading-detail.tsx", import.meta.url),
      "utf8",
    );

    expect(route).toContain(
      "WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no",
    );
    expect(route).not.toContain(
      "GROUP BY bo.order_id ORDER BY bo.sequence_no",
    );
    expect(route).not.toMatch(/module_codes\s*\([^)]*\)\s+AS\s*\(\s*VALUES/i);
    expect(route).toContain("UNION ALL SELECT 'tracking'");
  });
});
