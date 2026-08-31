import { describe, expect, it } from "vitest";
import {
  nextDensity,
  nextMotion,
  normalizeDensity,
  normalizeMotion,
} from "./workspace-preferences";

describe("workspace preferences", () => {
  it("falls back to production-friendly compact density", () => {
    expect(normalizeDensity(null)).toBe("compact");
    expect(normalizeDensity("unknown")).toBe("compact");
    expect(normalizeDensity("comfortable")).toBe("comfortable");
  });

  it("keeps motion enabled unless the user explicitly disables it", () => {
    expect(normalizeMotion(null)).toBe("on");
    expect(normalizeMotion("unknown")).toBe("on");
    expect(normalizeMotion("off")).toBe("off");
  });

  it("toggles density and motion deterministically", () => {
    expect(nextDensity("compact")).toBe("comfortable");
    expect(nextDensity("comfortable")).toBe("compact");
    expect(nextMotion("on")).toBe("off");
    expect(nextMotion("off")).toBe("on");
  });
});
