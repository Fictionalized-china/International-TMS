import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const run = vi.fn();
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { run, bind, prepare };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: { prepare: harness.prepare } } }));

import { writeAudit, writeAuditStrict } from "./audit.server";

const input = {
  request: new Request("https://example.test/admin"),
  action: "customer.update",
  resourceType: "customer",
  resourceId: "customer-1",
  organizationId: "organization-1",
  actorUserId: "user-1",
};

describe("audit persistence policy", () => {
  beforeEach(() => {
    harness.run.mockReset();
    harness.bind.mockClear();
    harness.prepare.mockClear();
  });

  it("persists audit records normally", async () => {
    harness.run.mockResolvedValueOnce({ success: true });

    await expect(writeAudit(input)).resolves.toBeUndefined();
    expect(harness.run).toHaveBeenCalledOnce();
  });

  it("does not turn an already-completed business operation into a visible failure", async () => {
    const error = new Error("audit storage unavailable");
    harness.run.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(writeAudit(input)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith("AUDIT_WRITE_FAILED", expect.objectContaining({
      action: input.action,
      resourceId: input.resourceId,
      error: error.message,
    }));
    consoleError.mockRestore();
  });

  it("offers an explicit fail-closed variant", async () => {
    harness.run.mockRejectedValueOnce(new Error("audit storage unavailable"));

    await expect(writeAuditStrict(input)).rejects.toThrow("audit storage unavailable");
  });
});
