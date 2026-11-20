import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";

describe("tracking center schema contract", () => {
  let fixture: Awaited<ReturnType<typeof meetingFixture>>;

  beforeAll(async () => {
    fixture = await meetingFixture();
  });

  afterAll(() => {
    fixture.database.close();
  });

  it("only references columns owned by the selected transport assignment", () => {
    const source = readFileSync(
      new URL("./tracking-center.server.ts", import.meta.url),
      "utf8",
    );
    const assignmentSubquery = source.match(
      /SELECT candidate\.id FROM order_transport_assignments candidate[\s\S]+?LIMIT 1/,
    )?.[0];
    expect(assignmentSubquery).toBeTruthy();

    const columns = new Set(
      fixture.database
        .prepare("PRAGMA table_info(order_transport_assignments)")
        .all()
        .map((row) => String(row.name)),
    );
    const referenced = [
      ...new Set(
        [...assignmentSubquery!.matchAll(/candidate\.([a-z_]+)/g)].map(
          (match) => match[1],
        ),
      ),
    ];

    expect(referenced.filter((column) => !columns.has(column))).toEqual([]);
    expect(referenced).toContain("actual_arrival_at");
  });
});
