import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { createSettlementAccessReadPhase, loadSettlementWorkbenchActionAccess, type SettlementAccessSource } from "./settlement-workbench-access.server";
import type { SettlementWorkbenchAction } from "./settlement-workbench-access";

vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup() {
  fixture = await meetingFixture(); seedFrozenMeetingWorkflow(fixture);
  for (const key of ["reconciliation_statement", "invoice_records", "cash_records", "writeoff_records"]) {
    fixture.database.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES(?,'instance','wf','reconciliation','costs',?,?,'text',1,1,?)").run(key,key,key,fixture.now);
  }
  fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,amount,created_at,updated_at) VALUES('fee','org','order','receivable','FREIGHT','运输费',100,?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,settlement_entity,currency,total_amount,status,created_by_user_id,created_at,updated_at) VALUES('statement','org','AR-PHASE','receivable','客户','公司','CNY',100,'confirmed','cs',?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('line','org','statement','fee',100,?)").run(fixture.now);
}
const cases: { action: SettlementWorkbenchAction; source: SettlementAccessSource; legacyFallback: "deny" }[] = [
  { action: "create_reconciliation", source: { kind: "expense_ids", ids: ["fee"] }, legacyFallback: "deny" },
  ...(["confirm_reconciliation", "record_invoice", "allocate_cash"] as const).map(action => ({ action, source: { kind: "reconciliation_id" as const, id: "statement" }, legacyFallback: "deny" as const })),
];

describe("settlement access write-free read phase", () => {
  it.each(["owner", "sales", "operation", "supervisor", "cs", "finance", "cashier", "commercial"])("keeps all %s row decisions identical and reduces repeated queries", async id => {
    await setup(); const actor = fixture.actors.get(id)!;
    const spy = vi.spyOn(fixture.db, "prepare");
    const expected = [];
    for (const input of cases) expected.push(await loadSettlementWorkbenchActionAccess(fixture.db, { ...input, actor }));
    const before = spy.mock.calls.length; spy.mockClear();
    const read = createSettlementAccessReadPhase(fixture.db, actor);
    const actual = [];
    for (const input of cases) actual.push(await read(input));
    expect(actual).toEqual(expected);
    expect(spy.mock.calls.length).toBeLessThan(before);
    expect(spy.mock.calls.filter(([sql]) => sql.includes("FROM business_process_policies")).length).toBe(1);
    expect(spy.mock.calls.filter(([sql]) => sql.includes("SELECT o.workflow_instance_id,wi.id matched_instance_id")).length).toBe(1);
    expect(spy.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });
  it("does not share stale facts with a later phase or a real submission", async () => {
    await setup(); const actor = fixture.actors.get("owner")!;
    const input = cases[3];
    expect((await createSettlementAccessReadPhase(fixture.db, actor)(input)).canWrite).toBe(true);
    fixture.database.exec("UPDATE workflow_instance_fields SET is_active=0 WHERE field_key IN ('cash_records','writeoff_records')");
    const current = await loadSettlementWorkbenchActionAccess(fixture.db, { ...input, actor });
    expect(current.canWrite).toBe(false);
    expect(await createSettlementAccessReadPhase(fixture.db, actor)(input)).toEqual(current);
    const revokedActor = { ...actor, permissions: [] };
    expect((await createSettlementAccessReadPhase(fixture.db, revokedActor)(cases[0])).canWrite).toBe(false);
  });
  it("fails closed for missing sources, foreign organizations and oversized source lists", async () => {
    await setup(); const actor = fixture.actors.get("owner")!;
    const read = createSettlementAccessReadPhase(fixture.db, actor);
    for (const source of [{ kind: "expense_ids", ids: ["fee", "missing"] }, { kind: "reconciliation_id", id: "missing" }, { kind: "order_ids", ids: Array.from({ length: 101 }, (_, i) => `order-${i}`) }] as SettlementAccessSource[]) {
      const input = { action: "allocate_cash" as const, source, legacyFallback: "deny" as const };
      expect(await read(input)).toEqual(await loadSettlementWorkbenchActionAccess(fixture.db, { ...input, actor }));
      expect((await read(input)).canWrite).toBe(false);
    }
    expect((await createSettlementAccessReadPhase(fixture.db, { ...actor, organizationId: "foreign" })(cases[0])).canWrite).toBe(false);
  });
  it("propagates failed reads rather than returning an old allow decision", async () => {
    await setup(); const actor = fixture.actors.get("owner")!;
    fixture.database.exec("DROP TABLE business_process_policies");
    await expect(createSettlementAccessReadPhase(fixture.db, actor)(cases[0])).rejects.toThrow();
  });
});
