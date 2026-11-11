import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { activeOrganizationAssigneePredicate, activeOrganizationAssigneeSelectionPredicate } from "./organization-assignee.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => { fixture = await meetingFixture(); });
afterEach(() => fixture?.database.close());
async function accepts(input: Parameters<typeof activeOrganizationAssigneePredicate>[0]) {
  const predicate = activeOrganizationAssigneePredicate(input);
  return (await fixture.db.prepare(`SELECT CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END valid`).bind(...predicate.values).first<{ valid: number }>())?.valid === 1;
}
describe("transactional organization assignee predicate", () => {
  it("uses AND across groups and OR within a group, just like the picker", async () => {
    const input = { organizationId: "org", userId: "supervisor", positionCodes: ["OPERATION_SUPERVISOR"], permissionRequirements: [["never.granted", "order.view"], [], ["order.module.assignment.manage"]] };
    expect(await accepts(input)).toBe(true);
    fixture.database.exec("DELETE FROM role_permissions WHERE role_id='org:role:pos_operation_supervisor' AND permission_code='order.module.assignment.manage'");
    expect(await accepts(input)).toBe(false);
    expect(await accepts({ ...input, permissionRequirements: [["never.granted", "order.view"]] })).toBe(true);
  });
  it("does not turn protected permissions into a bypass for organization or expected position", async () => {
    const input = { organizationId: "org", userId: "owner", positionCodes: ["BOSS"], permissionRequirements: [["never.granted"]] };
    expect(await accepts(input)).toBe(true);
    expect(await accepts({ ...input, organizationId: "another-org" })).toBe(false);
    expect(await accepts({ ...input, positionCodes: ["OPERATION"] })).toBe(false);
    expect(await accepts({ ...input, positionCodes: [] })).toBe(false);
  });
  it("retains the exact display-name requirement for new historical snapshot selections", async () => {
    const input = { organizationId: "org", userId: "commercial", positionCodes: ["BUSINESS_ROUTE"], displayName: "commercial" };
    expect(activeOrganizationAssigneeSelectionPredicate(input)).toEqual(activeOrganizationAssigneePredicate(input));
    expect(await accepts(input)).toBe(true);
    fixture.database.exec("UPDATE users SET display_name='新的商务姓名' WHERE id='commercial'");
    expect(await accepts(input)).toBe(false);
    expect(await accepts({ ...input, displayName: undefined })).toBe(true);
  });
  it("requires an active position role even when no explicit permission groups are needed", async () => {
    expect(await accepts({ organizationId: "org", userId: "operation" })).toBe(true);
    fixture.database.exec("UPDATE roles SET status='disabled' WHERE organization_id='org' AND code='pos_operation'");
    expect(await accepts({ organizationId: "org", userId: "operation" })).toBe(false);
  });
});
