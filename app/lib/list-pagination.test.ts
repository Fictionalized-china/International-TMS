import { describe, expect, it } from "vitest";
import { paginateList, readListPage } from "./list-pagination";

describe("list pagination", () => {
  it("keeps no more than ten records on each order page", () => {
    const result = paginateList(Array.from({ length: 23 }, (_, index) => index + 1), 2);
    expect(result.items).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(result).toMatchObject({ page: 2, pageCount: 3, pageSize: 10, total: 23 });
  });

  it("clamps invalid and out-of-range page values", () => {
    expect(readListPage(new URLSearchParams("page=-2"))).toBe(1);
    expect(paginateList([1, 2], 99)).toMatchObject({ page: 1, pageCount: 1 });
  });
});
