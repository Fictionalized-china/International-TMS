import { describe, expect, it } from "vitest";
import {
  isRetryableMysqlTransactionError,
  mysqlPoolQueueLimit,
  mysqlTransactionRetryDelayMs,
  readBoundedInteger,
} from "./mysql-transaction-policy";

describe("MySQL transaction policy", () => {
  it.each([
    [{ code: "ER_LOCK_DEADLOCK" }],
    [{ code: "ER_LOCK_WAIT_TIMEOUT" }],
    [{ errno: 1213 }],
    [{ cause: { errno: 1205 } }],
  ])("recognizes retryable transaction failures", (error) => {
    expect(isRetryableMysqlTransactionError(error)).toBe(true);
  });

  it("does not retry unrelated database failures", () => {
    expect(
      isRetryableMysqlTransactionError({ code: "ER_DUP_ENTRY", errno: 1062 }),
    ).toBe(false);
    expect(
      isRetryableMysqlTransactionError(new Error("network unavailable")),
    ).toBe(false);
  });

  it("bounds integer environment configuration", () => {
    expect(readBoundedInteger(undefined, 6, 1, 32)).toBe(6);
    expect(readBoundedInteger("not-a-number", 6, 1, 32)).toBe(6);
    expect(readBoundedInteger("0", 6, 1, 32)).toBe(1);
    expect(readBoundedInteger("99", 6, 1, 32)).toBe(32);
    expect(readBoundedInteger("8.9", 6, 1, 32)).toBe(8);
  });

  it("keeps enough queued reads for one heavy order detail plus portal traffic", () => {
    expect(mysqlPoolQueueLimit(undefined)).toBe(256);
    expect(mysqlPoolQueueLimit("24")).toBe(64);
    expect(mysqlPoolQueueLimit("4000")).toBe(2000);
  });

  it("uses a capped exponential retry delay", () => {
    expect([0, 1, 2, 3, 4].map(mysqlTransactionRetryDelayMs)).toEqual([
      25, 50, 100, 200, 250,
    ]);
  });
});
