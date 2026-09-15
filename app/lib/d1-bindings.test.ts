import { describe, expect, it } from "vitest";
import {
  chunkD1Values,
  chunkD1Rows,
  D1_DEFAULT_DYNAMIC_BINDINGS,
  D1_MAX_BOUND_PARAMETERS,
  d1Placeholders,
} from "./d1-bindings";

describe("D1 binding safety", () => {
  it("splits large id lists below the platform parameter limit", () => {
    const values = Array.from({ length: 205 }, (_, index) => `id-${index}`);
    const chunks = chunkD1Values(values, 1);
    expect(chunks.map((chunk) => chunk.length)).toEqual([80, 80, 45]);
    expect(chunks.flat()).toEqual(values);
    expect(Math.max(...chunks.map((chunk) => chunk.length)) + 1)
      .toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it("reserves fixed bindings when fewer dynamic slots remain", () => {
    expect(chunkD1Values(Array.from({ length: 25 }, (_, index) => index), 90)
      .map((chunk) => chunk.length)).toEqual([10, 10, 5]);
    expect(chunkD1Values([1, 2, 3], 99)).toEqual([[1], [2], [3]]);
    expect(chunkD1Values([], 1)).toEqual([]);
    expect(() => chunkD1Values([1], 100)).toThrow("no binding capacity");
  });

  it("builds placeholders only inside the D1 hard limit", () => {
    expect(d1Placeholders(D1_DEFAULT_DYNAMIC_BINDINGS).split(",")).toHaveLength(80);
    expect(() => d1Placeholders(D1_MAX_BOUND_PARAMETERS + 1)).toThrow(
      "cannot bind more than",
    );
    expect(() => d1Placeholders(0)).toThrow("at least one binding");
  });

  it("packs multi-row statements by bindings used per row", () => {
    const rows = Array.from({ length: 35 }, (_, index) => index);
    expect(chunkD1Rows(rows, 8).map((chunk) => chunk.length)).toEqual([12, 12, 11]);
    expect(chunkD1Rows(rows, 6, 4).map((chunk) => chunk.length)).toEqual([16, 16, 3]);
    expect(chunkD1Rows([], 8)).toEqual([]);
    expect(() => chunkD1Rows([1], 101)).toThrow("cannot fit one row");
  });

});
