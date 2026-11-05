import { afterEach, describe, expect, it } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { loadActivePositionAccessProfile } from "./position-access-profile.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
describe("protected boss permissions and ordinary position isolation", () => {
  it("keeps the boss at company scope with all registered permissions while respecting an ordinary self scope", async () => {
    fixture = await meetingFixture();
    for (const code of ["BOSS", "OPERATION"]) {
      fixture.database.prepare("UPDATE position_portal_settings SET business_data_scope='self' WHERE organization_id='org' AND position_id=(SELECT id FROM positions WHERE organization_id='org' AND code=?)").run(code);
    }
    const before = await loadActivePositionAccessProfile(fixture.db, "org", "operation");
    fixture.database.prepare("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE organization_id='org' AND code=?)").run(fixture.actors.get("owner")!.roleCodes[0]);
    const boss = await loadActivePositionAccessProfile(fixture.db, "org", "owner");
    const ordinary = await loadActivePositionAccessProfile(fixture.db, "org", "operation");
    const permissions = fixture.database.prepare("SELECT code FROM permissions ORDER BY code").all().map(row => row.code);
    expect(boss).toMatchObject({ positionCode: "BOSS", dataScope: "company" });
    expect(boss?.permissions).toEqual(permissions);
    expect(ordinary).toEqual(before);
    expect(ordinary?.dataScope).toBe("self");
    expect(ordinary?.permissions).not.toContain("billing.cash.manage");
    expect(ordinary?.permissions.length).toBeLessThan(permissions.length);
  });
});
