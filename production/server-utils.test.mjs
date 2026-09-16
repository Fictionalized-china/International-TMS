import { describe, expect, it } from "vitest";

import {
  resolveStaticRequestPath,
  safeRequestPathname,
} from "./server-utils.mjs";

describe("production server request boundary", () => {
  it("classifies malformed URL encoding instead of throwing", () => {
    expect(safeRequestPathname("/%zz", "localhost")).toEqual({ kind: "malformed" });
  });

  it("resolves a normal asset inside the client build root", () => {
    const result = resolveStaticRequestPath("C:\\srv\\client", "/assets/app.js", "localhost");

    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.path).toBe("C:\\srv\\client\\assets\\app.js");
    }
  });

  it("rejects decoded traversal outside the client build root", () => {
    expect(
      resolveStaticRequestPath("C:\\srv\\client", "/..%5csecret.txt", "localhost"),
    ).toEqual({ kind: "outside-root" });
  });

  it("allows a legitimate child path whose name starts with two dots", () => {
    const result = resolveStaticRequestPath(
      "C:\\srv\\client",
      "/.well-known/security.txt",
      "localhost",
    );
    expect(result.kind).toBe("candidate");
  });
});
