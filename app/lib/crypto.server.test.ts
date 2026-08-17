import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.server";

describe("authentication crypto", () => {
  it("creates non-reversible password hashes", async () => {
    const encoded = await hashPassword("StrongPassword2026");
    expect(encoded).toContain("pbkdf2_sha256$100000$");
    expect(encoded).not.toContain("StrongPassword2026");
    await expect(verifyPassword("StrongPassword2026", encoded)).resolves.toBe(true);
    await expect(verifyPassword("WrongPassword2026", encoded)).resolves.toBe(false);
  });
  it("generates unique opaque session tokens", () => expect(randomToken()).not.toBe(randomToken()));
  it("produces stable token fingerprints", async () => expect(await sha256("token")).toHaveLength(64));
});
