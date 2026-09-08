import { describe, expect, it } from "vitest";

import { scanInboundMarkAtWarehouse } from "./warehouse-inbound-scan-session.server";

type FakeStatement = {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => FakeStatement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function inboundScanDb() {
  const statement = (sql: string): FakeStatement => {
    const current: FakeStatement = {
      sql,
      values: [],
      bind(...values) {
        current.values = values;
        return current;
      },
      async first<T>() {
        if (sql.includes("FROM warehouse_inbound_scan_sessions")) {
          return { id: "scan-session-1" } as T;
        }
        if (sql.includes("FROM warehouse_inbound_mark_receipts")) return null;
        if (sql.includes("FROM warehouse_inbound_order_receiving_sessions")) {
          return { id: "receiving-session-1" } as T;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM order_cargo_packages mark")) {
          return {
            results: [{
              inbound_mark_id: "mark-1",
              order_id: "order-1",
              order_number: "SO2026090800320",
              shipment_id: "shipment-1",
              eligible_warehouse_id: "warehouse-1",
              mark_status: "planned",
            } as T],
          };
        }
        return { results: [] };
      },
      async run() {
        return { meta: { changes: 1 } };
      },
    };
    return current;
  };

  return {
    prepare: statement,
    async batch(statements: FakeStatement[]) {
      for (const prepared of statements) {
        const placeholders = (prepared.sql.match(/\?/g) || []).length;
        if (placeholders !== prepared.values.length) {
          throw new Error(
            `placeholder mismatch: ${placeholders} placeholders for ${prepared.values.length} values`,
          );
        }
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

describe("scanInboundMarkAtWarehouse", () => {
  it("atomically records the first valid IN mark scan", async () => {
    const result = await scanInboundMarkAtWarehouse(inboundScanDb() as never, {
      organizationId: "organization-1",
      warehouseId: "warehouse-1",
      userId: "warehouse-user-1",
      code: "so2026090800320-in-001",
      now: "2026-09-09T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      outcome: "accepted",
      orderId: "order-1",
      orderNumber: "SO2026090800320",
      inboundMarkId: "mark-1",
      orderReceivingSessionId: "receiving-session-1",
    });
  });
});
