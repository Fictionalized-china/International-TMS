import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("./routes/admin.loading.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

describe("loading tracking filter layout", () => {
  it("keeps the primary filters and actions in one compact desktop row", () => {
    expect(route).toContain("loading-tracking-filter__query");
    expect(route).toContain("loading-tracking-filter__status");
    expect(route).toContain("loading-tracking-filter__actions");
    expect(route).toContain("loading-tracking-filter__advanced");
    expect(css).toMatch(/\.loading-tracking-filter\s*\{[\s\S]*grid-template-columns:\s*minmax\(260px, 460px\)/);
    expect(css).toContain(".loading-tracking-filter__query { max-width: 460px; }");
  });

  it("retains responsive fallbacks without horizontal overflow", () => {
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*\.loading-tracking-filter\s*\{[\s\S]*grid-template-columns:/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.loading-tracking-filter \{ grid-template-columns: 1fr; \}/);
  });
});
