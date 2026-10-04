import { DatabaseSync } from "node:sqlite";
import { describe,expect,it } from "vitest";
import { loadingTrackingFilters } from "./loading-tracking-filters";

describe("loading tracking advanced filters",()=>{
  it("keeps the final selected departure day inclusive",()=>{
    const db=new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE transport_batches(id TEXT,planned_departure_at TEXT);
        INSERT INTO transport_batches VALUES('in','2026-10-04T23:59'),('out','2026-10-05T00:00');`);
      const filters=loadingTrackingFilters(new URLSearchParams({departureFrom:"2026-10-04",departureTo:"2026-10-04"}));
      expect(db.prepare(`SELECT id FROM transport_batches b WHERE 1=1 ${filters.sql}`).all(...filters.values)).toEqual([{id:"in"}]);
    } finally {db.close();}
  });
  it("does not interpolate customer or destination input into SQL",()=>{
    const input="x' OR 1=1 --";
    const filters=loadingTrackingFilters(new URLSearchParams({customer:input,destination:input}));
    expect(filters.sql).not.toContain(input);
    expect(filters.values).toEqual([input,input]);
    expect(filters.sql).toContain("fbo.status!='removed'");
    expect(filters.sql).toContain("fc.organization_id=fo.organization_id");
  });
  it("ignores invalid calendar dates rather than filtering using a normalized unintended date",()=>{
    expect(loadingTrackingFilters(new URLSearchParams({departureFrom:"2026-02-31"})).values).toEqual([]);
  });
});
