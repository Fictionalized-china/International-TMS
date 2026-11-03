import { describe, expect, it } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { adminPrimaryNavigationGroups } from "./admin-workspace-navigation";
import { canViewOrderWorkbench, canViewTrackingCenter } from "./transport-workspace-access";
import { readFileSync } from "node:fs";
import { loadActivePositionAccessProfile } from "./position-access-profile.server";

describe("transport permissions after all real migrations and role bootstrap", () => {
  it("separates operation, tracking and commercial entrances while preserving owner access", async () => {
    const fixture = await meetingFixture();
    try {
      const { actors } = fixture;
      const operation = actors.get("operation")!;
      const commercial = actors.get("commercial")!;
      expect(canViewTrackingCenter(operation)).toBe(false);
      expect(canViewOrderWorkbench(operation, "costs")).toBe(false);
      expect(canViewTrackingCenter(actors.get("tracker")!)).toBe(true);
      expect(canViewTrackingCenter(actors.get("supervisor")!)).toBe(true);
      expect(canViewTrackingCenter(actors.get("owner")!)).toBe(true);
      expect(canViewOrderWorkbench(actors.get("finance")!, "costs")).toBe(true);
      expect(commercial.permissions).toEqual(expect.arrayContaining(["dispatch.view", "dispatch.manage", "menu.admin.dispatch.view"]));
      expect(canViewTrackingCenter(commercial)).toBe(false);
      for (const actor of actors.values()) {
        const items = adminPrimaryNavigationGroups(actor).flatMap(group => group.items);
        expect(new Set(items.map(item => item.key)).size).toBe(items.length);
        if (actor === operation) expect(items.map(item => item.label)).not.toContain("调度与运踪");
        if (actor === commercial) expect(items.map(item => item.label)).toContain("找车");
      }
    } finally { fixture.database.close(); }
  });
  it("repairs the actual legacy operation tracking grant without removing domestic transport", async () => {
    const fixture = await meetingFixture();
    try {
      const roleId = "org:role:pos_operation";
      for (const permission of ["order.module.tracking.manage", "tracking.daily.manage", "tracking.center.view", "menu.admin.tracking_center.view"]) {
        fixture.database.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_code) VALUES(?,?)").run(roleId, permission);
      }
      fixture.database.exec(readFileSync(new URL("../../migrations/0182_dispatch_workbench_access.sql", import.meta.url), "utf8"));
      const profile = await loadActivePositionAccessProfile(fixture.db, "org", "operation");
      expect(profile?.permissions).toEqual(expect.arrayContaining(["order.module.transport.manage", "shipment.view", "transport.batch.assigned.view"]));
      expect(profile?.permissions).not.toEqual(expect.arrayContaining(["order.module.tracking.manage"]));
      expect(profile?.permissions).not.toEqual(expect.arrayContaining(["menu.admin.tracking_center.view"]));
      expect(canViewTrackingCenter({ permissions: profile!.permissions })).toBe(false);
    } finally { fixture.database.close(); }
  });
});
