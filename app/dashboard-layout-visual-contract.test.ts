import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const marker = "StyleKit dashboard-layout visual contract";
const start = css.lastIndexOf(marker);
const contract = start >= 0 ? css.slice(start) : "";

describe("StyleKit dashboard layout visual contract", () => {
  it("is the final presentation layer and keeps the existing TMS palette", () => {
    expect(start).toBeGreaterThan(
      css.lastIndexOf("Direct intake: one task per page"),
    );
    expect(contract).toContain("--dashboard-accent: var(--orange);");
    expect(contract).toContain("--dashboard-accent: var(--green);");
    expect(contract).not.toContain("#6366f1");
  });

  it("covers the three existing shells without introducing page content", () => {
    expect(contract).toContain(".admin-app-shell");
    expect(contract).toContain(".warehouse-app-shell");
    expect(contract).toContain(".prototype-portal-shell");
    expect(contract).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr));",
    );
    expect(contract).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr));",
    );
    expect(contract).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(contract).toContain("@media (max-width: 820px)");
    expect(contract).toContain(":root { --sidebar: 62px; }");
    expect(contract).toContain(".analytics-kpi-grid.compact");
  });

  it("normalises cards, controls and precise interaction feedback", () => {
    expect(contract).toContain("--dashboard-panel-radius: 10px;");
    expect(contract).toContain("--dashboard-control-radius: 7px;");
    expect(contract).toContain("--dashboard-transition: 150ms ease-out;");
    expect(contract).toContain("transform: scale(0.97);");
    expect(contract).toContain(
      "outline: 2px solid var(--dashboard-accent, var(--orange));",
    );
    expect(contract).toContain("background-color: #f8fafb;");
  });

  it("preserves accessible motion and table overflow fallbacks", () => {
    expect(contract).toContain("overscroll-behavior-inline: contain;");
    expect(contract).toContain("@media (prefers-reduced-motion: reduce)");
    expect(contract).toContain("transition-duration: 0.01ms !important;");
    expect(contract).toContain("animation-iteration-count: 1 !important;");
  });
});
