import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import {
  hasCompletedDomesticWarehouseDispatch,
  loadOrderTransportCompletionState,
  orderTransportCompletionPredicate,
  orderTransportCompletionPredicateValues,
} from "./order-transport-completion.server";
import { actualExportSql } from "./meeting-settlement.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;

beforeEach(async () => {
  fixture = await meetingFixture();
  const sql = fixture.database;
  const now = fixture.now;
  sql.prepare(
    "INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,serial_code,created_at,updated_at) VALUES('warehouse','org','WH','国内仓','domestic_collection','01',?,?)",
  ).run(now, now);
  sql.prepare(
    "INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','warehouse','Z','收货区',?,?)",
  ).run(now, now);
  sql.prepare(
    "INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('location','org','warehouse','zone','L','库位',?,?)",
  ).run(now, now);
  sql.prepare(
    "INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,created_at,updated_at) VALUES('shipment','org','SHIP-PARTIAL','order','customer',?,?)",
  ).run(now, now);
  sql.prepare(
    `INSERT INTO warehouse_receipts(
      id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,
      cargo_complete,received_at,created_at,updated_at
    ) VALUES('receipt','org','IN-PARTIAL','shipment','warehouse','location',1,?,?,?)`,
  ).run(now, now, now);
  sql.prepare(
    `INSERT INTO warehouse_packing_jobs(
      id,organization_id,warehouse_id,order_id,shipment_id,packing_mode,
      source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,
      status,created_by_user_id,created_at,updated_at
    ) VALUES('job','org','warehouse','order','shipment','split',2,2,30,3,'labelled','supervisor',?,?)`,
  ).run(now, now);
  for (const [id, sequence, weight] of [["oul-1", 1, 10], ["oul-2", 2, 20]] as const) {
    sql.prepare(
      `INSERT INTO warehouse_packages(
        id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,
        barcode,package_number,pieces,weight_kg,volume_cbm,status,label_kind,
        lifecycle_status,packing_job_id,created_at,updated_at
      ) VALUES(?,'org','receipt','shipment','warehouse','location',?,?,1,?,1,'in_stock','oul','active','job',?,?)`,
    ).run(id, `OUL-${sequence}`, `P-${sequence}`, weight, now, now);
  }
});

afterEach(() => fixture?.database.close());

function addBatch(id: string, packageId: string) {
  const sql = fixture.database;
  const now = fixture.now;
  sql.prepare(
    `INSERT INTO transport_batches(
      id,organization_id,order_id,batch_number,batch_name,origin_location,
      destination_location,warehouse_id,created_by_user_id,created_at,updated_at
    ) VALUES(?,'org','order',?,?,'国内仓','境外仓','warehouse','supervisor',?,?)`,
  ).run(id, `PZ-${id}`, id, now, now);
  sql.prepare(
    `INSERT INTO transport_batch_orders(
      id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at
    ) VALUES(?,'org',?,'order',1,'planned','supervisor',?,?)`,
  ).run(`membership-${id}`, id, now, now);
  sql.prepare(
    `INSERT INTO transport_batch_packages(
      id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,status,
      added_by_user_id,created_at,updated_at
    ) VALUES(?,'org',?,'order','job',?,1,'planned','supervisor',?,?)`,
  ).run(`batch-package-${id}`, id, packageId, now, now);
}

describe("partial-order batch database guards", () => {
  it("recognizes FTL domestic handover without inventing a PZ package membership", () => {
    const shared={
      totalPackageCount:1,
      waitingDispatchCount:0,
      untrackedDepartedCount:1,
    };
    expect(hasCompletedDomesticWarehouseDispatch({
      businessType:"ftl",batchPackageCount:0,warehouseDispatched:1,transportState:shared,
    })).toBe(true);
    expect(hasCompletedDomesticWarehouseDispatch({
      businessType:"ltl",batchPackageCount:0,warehouseDispatched:1,transportState:shared,
    })).toBe(false);
    expect(hasCompletedDomesticWarehouseDispatch({
      businessType:"ltl",batchPackageCount:1,warehouseDispatched:1,
      transportState:{...shared,untrackedDepartedCount:0},
    })).toBe(true);
  });

  it("allows one order in several batches while each OUL remains exclusive", () => {
    addBatch("a", "oul-1");
    addBatch("b", "oul-2");
    expect(fixture.database.prepare(
      "SELECT batch_id FROM transport_batch_order_claims WHERE order_id='order' ORDER BY batch_id",
    ).all()).toEqual([{ batch_id: "a" }, { batch_id: "b" }]);
    expect(fixture.database.prepare(
      "SELECT package_id,batch_id FROM transport_batch_package_claims ORDER BY package_id",
    ).all()).toEqual([
      { package_id: "oul-1", batch_id: "a" },
      { package_id: "oul-2", batch_id: "b" },
    ]);
  });

  it("keeps the order incomplete until every split batch OUL has arrived", async () => {
    addBatch("a", "oul-1");
    addBatch("b", "oul-2");

    expect(await loadOrderTransportCompletionState(fixture.db, "org", "order"))
      .toMatchObject({ complete: false, totalPackageCount: 2, waitingDispatchCount: 2, waitingArrivalCount: 2 });

    fixture.database.exec(`
      UPDATE warehouse_packages SET status='in_stock',lifecycle_status='overseas_received' WHERE id='oul-1';
      UPDATE transport_batch_packages SET status='arrived' WHERE package_id='oul-1';
      UPDATE warehouse_packages SET status='dispatched',lifecycle_status='in_transit' WHERE id='oul-2';
      UPDATE transport_batch_packages SET status='departed' WHERE package_id='oul-2';
    `);
    expect(await loadOrderTransportCompletionState(fixture.db, "org", "order"))
      .toMatchObject({ complete: false, waitingDispatchCount: 0, waitingArrivalCount: 1 });

    fixture.database.exec(`
      UPDATE warehouse_packages SET status='in_stock',lifecycle_status='overseas_received' WHERE id='oul-2';
      UPDATE transport_batch_packages SET status='arrived' WHERE package_id='oul-2';
    `);
    expect(await loadOrderTransportCompletionState(fixture.db, "org", "order"))
      .toEqual({
        complete: true,
        totalPackageCount: 2,
        waitingDispatchCount: 0,
        waitingArrivalCount: 0,
        untrackedDepartedCount: 0,
        reason: null,
      });
    const committed = await fixture.db.prepare(
      `SELECT CASE WHEN ${orderTransportCompletionPredicate()} THEN 1 ELSE 0 END ready`,
    ).bind(...orderTransportCompletionPredicateValues("org", "order")).first<{ ready: number }>();
    expect(committed).toEqual({ ready: 1 });
  });

  it("does not open order-level settlement after only the first split batch has exported", () => {
    addBatch("a", "oul-1");
    addBatch("b", "oul-2");
    fixture.database.exec(`
      UPDATE transport_batch_packages SET status='departed' WHERE batch_id='a';
      UPDATE transport_batches SET status='departed',road_status='outbound_in_transit' WHERE id='a';
    `);
    const exported = () => fixture.database.prepare(
      `SELECT CASE WHEN ${actualExportSql("o")} THEN 1 ELSE 0 END ready
       FROM transport_orders o WHERE o.organization_id='org' AND o.id='order'`,
    ).get() as { ready: number };
    expect(exported()).toEqual({ ready: 0 });
    fixture.database.exec(`
      UPDATE transport_batch_packages SET status='departed' WHERE batch_id='b';
      UPDATE transport_batches SET status='departed',road_status='outbound_in_transit' WHERE id='b';
    `);
    expect(exported()).toEqual({ ready: 1 });
  });

  it("does not treat an untracked departed OUL as transport-complete", async () => {
    fixture.database.exec(
      "UPDATE warehouse_packages SET status='dispatched',lifecycle_status='in_transit' WHERE id='oul-1'",
    );
    expect(await loadOrderTransportCompletionState(fixture.db, "org", "order"))
      .toMatchObject({ complete: false, untrackedDepartedCount: 1 });
  });

  it("does not treat an order without any effective OUL as transport-complete", async () => {
    fixture.database.exec("UPDATE warehouse_packages SET lifecycle_status='voided' WHERE packing_job_id='job'");
    expect(await loadOrderTransportCompletionState(fixture.db, "org", "order"))
      .toMatchObject({ complete: false, totalPackageCount: 0 });
    const committed = await fixture.db.prepare(
      `SELECT CASE WHEN ${orderTransportCompletionPredicate()} THEN 1 ELSE 0 END ready`,
    ).bind(...orderTransportCompletionPredicateValues("org", "order")).first<{ ready: number }>();
    expect(committed).toEqual({ ready: 0 });
  });

  it("rolls back a losing batch that tries to claim an occupied OUL", async () => {
    addBatch("winner", "oul-1");
    await expect(fixture.db.batch([
      fixture.db.prepare(`INSERT INTO transport_batches(
        id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,
        warehouse_id,created_by_user_id,created_at,updated_at
      ) VALUES('loser','org','order','PZ-loser','loser','国内仓','境外仓','warehouse','supervisor',?,?)`).bind(fixture.now, fixture.now),
      fixture.db.prepare(`INSERT INTO transport_batch_orders(
        id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at
      ) VALUES('membership-loser','org','loser','order',1,'planned','supervisor',?,?)`).bind(fixture.now, fixture.now),
      fixture.db.prepare(`INSERT INTO transport_batch_packages(
        id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,status,
        added_by_user_id,created_at,updated_at
      ) VALUES('batch-package-loser','org','loser','order','job','oul-1',1,'planned','supervisor',?,?)`).bind(fixture.now, fixture.now),
    ])).rejects.toThrow("transport_batch_package_claims");
  });

  it("releases only a cancelled batch's OUL and rejects an unsafe restore", () => {
    addBatch("a", "oul-1");
    addBatch("b", "oul-2");
    fixture.database.exec("UPDATE transport_batches SET status='cancelled' WHERE id='a'");
    addBatch("c", "oul-1");
    expect(() => fixture.database.exec("UPDATE transport_batches SET status='planning' WHERE id='a'"))
      .toThrow("transport_batch_package_claims");
    expect(fixture.database.prepare("SELECT status FROM transport_batches WHERE id='a'").get())
      .toEqual({ status: "cancelled" });
    expect(fixture.database.prepare(
      "SELECT package_id,batch_id FROM transport_batch_package_claims ORDER BY package_id",
    ).all()).toEqual([
      { package_id: "oul-1", batch_id: "c" },
      { package_id: "oul-2", batch_id: "b" },
    ]);
  });

  it("does not cancel a batch after one of its OULs has physically departed", () => {
    addBatch("a", "oul-1");
    fixture.database.exec("UPDATE transport_batch_packages SET status='departed' WHERE batch_id='a'");

    expect(() => fixture.database.exec("UPDATE transport_batches SET status='cancelled' WHERE id='a'"))
      .toThrow("transport_batch_with_physical_handover_cannot_be_cancelled");
    expect(fixture.database.prepare("SELECT status FROM transport_batches WHERE id='a'").get())
      .toEqual({ status: "planning" });
    expect(fixture.database.prepare(
      "SELECT package_id,batch_id FROM transport_batch_package_claims WHERE package_id='oul-1'",
    ).get()).toEqual({ package_id: "oul-1", batch_id: "a" });
  });
});

describe("active warehouse dispatch OUL claims", () => {
  function addDispatch(id: string) {
    const sql = fixture.database;
    const now = fixture.now;
    sql.prepare(
      `INSERT INTO warehouse_sorting_batches(
        id,organization_id,batch_number,shipment_id,target_location_id,status,created_at,updated_at
      ) VALUES(?,'org',?,'shipment','location','verified',?,?)`,
    ).run(`sorting-${id}`, `SORT-${id}`, now, now);
    sql.prepare(
      `INSERT INTO warehouse_dispatches(
        id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,
        driver_name,destination,status,created_at,updated_at
      ) VALUES(?,'org',?,?,'shipment','TEST','测试司机','境外仓','loading',?,?)`,
    ).run(id, `OUT-${id}`, `sorting-${id}`, now, now);
  }

  it("prevents concurrent active dispatches but releases the OUL after cancellation", () => {
    addDispatch("dispatch-a");
    addDispatch("dispatch-b");
    fixture.database.exec(
      "INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id) VALUES('item-a','org','dispatch-a','oul-1')",
    );
    expect(() => fixture.database.exec(
      "INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id) VALUES('item-b','org','dispatch-b','oul-1')",
    )).toThrow("warehouse_dispatch_package_claims");
    fixture.database.exec("UPDATE warehouse_dispatches SET status='cancelled' WHERE id='dispatch-a'");
    fixture.database.exec(
      "INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id) VALUES('item-b','org','dispatch-b','oul-1')",
    );
    expect(() => fixture.database.exec(
      "UPDATE warehouse_dispatches SET status='loading' WHERE id='dispatch-a'",
    )).toThrow("warehouse_dispatch_package_claims");
    expect(fixture.database.prepare("SELECT status FROM warehouse_dispatches WHERE id='dispatch-a'").get())
      .toEqual({ status: "cancelled" });
    expect(fixture.database.prepare("SELECT dispatch_id FROM warehouse_dispatch_package_claims").get())
      .toEqual({ dispatch_id: "dispatch-b" });
  });

  it("does not cancel a dispatch after the physical handover is completed", () => {
    addDispatch("dispatch-a");
    fixture.database.exec(
      "INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status) VALUES('item-a','org','dispatch-a','oul-1','loaded')",
    );
    fixture.database.exec("UPDATE warehouse_dispatches SET status='dispatched' WHERE id='dispatch-a'");

    expect(() => fixture.database.exec(
      "UPDATE warehouse_dispatches SET status='cancelled' WHERE id='dispatch-a'",
    )).toThrow("dispatched_warehouse_handover_cannot_be_cancelled");
    expect(fixture.database.prepare("SELECT status FROM warehouse_dispatches WHERE id='dispatch-a'").get())
      .toEqual({ status: "dispatched" });
    expect(fixture.database.prepare("SELECT dispatch_id FROM warehouse_dispatch_package_claims").get())
      .toEqual({ dispatch_id: "dispatch-a" });
  });
});
