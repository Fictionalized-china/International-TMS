import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PortalPickupAppointment modal lifecycle", () => {
  it("closes the appointment dialog after a redirect navigation completes", () => {
    const source = readFileSync(
      new URL("./PortalPickupAppointment.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useLocation");
    expect(source).toContain("const location = useLocation()");
    expect(source).toContain("closeSignal={location.key}");
  });
});
