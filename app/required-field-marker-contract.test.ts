import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

describe("required field marker contract", () => {
  it("does not generate a second marker when the label already renders one", () => {
    expect(css).toContain(":not(:has(> span:first-child .required-mark))");
    expect(css).toContain(":not(:has(> span:first-child > b))");
    expect(css).toContain(":required:invalid");
  });
});
