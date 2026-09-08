import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0140_warehouse_packing_batches.sql"


class WarehousePackingBatchesMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(
            """
            CREATE TABLE organizations(id TEXT PRIMARY KEY);
            CREATE TABLE users(id TEXT PRIMARY KEY);
            CREATE TABLE warehouses(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id)
            );
            CREATE TABLE warehouse_locations(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              warehouse_id TEXT NOT NULL REFERENCES warehouses(id)
            );
            CREATE TABLE transport_orders(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id)
            );
            CREATE TABLE transport_batches(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              warehouse_id TEXT REFERENCES warehouses(id)
            );
            CREATE TABLE transport_batch_orders(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              batch_id TEXT NOT NULL REFERENCES transport_batches(id),
              order_id TEXT NOT NULL REFERENCES transport_orders(id),
              status TEXT NOT NULL
            );
            CREATE TABLE shipments(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              order_id TEXT NOT NULL REFERENCES transport_orders(id)
            );
            CREATE TABLE warehouse_receipts(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              shipment_id TEXT NOT NULL REFERENCES shipments(id),
              warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
              location_id TEXT NOT NULL REFERENCES warehouse_locations(id)
            );
            CREATE TABLE warehouse_packages(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              receipt_id TEXT NOT NULL REFERENCES warehouse_receipts(id),
              shipment_id TEXT NOT NULL REFERENCES shipments(id),
              warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
              location_id TEXT NOT NULL REFERENCES warehouse_locations(id),
              barcode TEXT NOT NULL,
              package_number TEXT NOT NULL,
              pieces INTEGER NOT NULL DEFAULT 1,
              weight_kg REAL,
              volume_cbm REAL,
              status TEXT NOT NULL,
              notes TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              cargo_item_id TEXT,
              label_kind TEXT NOT NULL,
              lifecycle_status TEXT NOT NULL,
              source_order_package_id TEXT,
              packing_revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE warehouse_dispatches(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              shipment_id TEXT NOT NULL REFERENCES shipments(id),
              transport_batch_id TEXT REFERENCES transport_batches(id),
              status TEXT NOT NULL
            );
            CREATE TABLE warehouse_dispatch_items(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES organizations(id),
              dispatch_id TEXT NOT NULL REFERENCES warehouse_dispatches(id),
              package_id TEXT NOT NULL REFERENCES warehouse_packages(id),
              status TEXT NOT NULL,
              UNIQUE(dispatch_id, package_id)
            );

            INSERT INTO organizations VALUES('org-1'),('org-2');
            INSERT INTO users VALUES('user-1');
            INSERT INTO warehouses VALUES
              ('warehouse-1','org-1'),('warehouse-2','org-1'),('warehouse-x','org-2');
            INSERT INTO warehouse_locations VALUES
              ('location-1','org-1','warehouse-1'),
              ('location-2','org-1','warehouse-2'),
              ('location-x','org-2','warehouse-x');
            INSERT INTO transport_orders VALUES
              ('order-a','org-1'),('order-b','org-1'),('order-x','org-2');
            INSERT INTO shipments VALUES
              ('shipment-a','org-1','order-a'),
              ('shipment-b','org-1','order-b'),
              ('shipment-x','org-2','order-x');
            INSERT INTO warehouse_receipts VALUES
              ('receipt-a','org-1','shipment-a','warehouse-1','location-1'),
              ('receipt-b','org-1','shipment-b','warehouse-1','location-1'),
              ('receipt-a-w2','org-1','shipment-a','warehouse-2','location-2'),
              ('receipt-x','org-2','shipment-x','warehouse-x','location-x');
            INSERT INTO transport_batches VALUES
              ('pz-1','org-1','warehouse-1'),
              ('pz-2','org-1','warehouse-2'),
              ('pz-x','org-2','warehouse-x');
            INSERT INTO transport_batch_orders VALUES
              ('pzo-a','org-1','pz-1','order-a','planned'),
              ('pzo-b','org-1','pz-1','order-b','planned'),
              ('pzo-a-removed','org-1','pz-2','order-a','removed');
            INSERT INTO warehouse_dispatches VALUES
              ('dispatch-ftl-a','org-1','shipment-a',NULL,'loading'),
              ('dispatch-ftl-b','org-1','shipment-b',NULL,'loading'),
              ('dispatch-pz','org-1','shipment-a','pz-1','loading'),
              ('dispatch-pz-w2','org-1','shipment-a','pz-2','loading');
            """
        )
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def add_package(
        self,
        package_id,
        shipment_id="shipment-a",
        warehouse_id="warehouse-1",
        label_kind="inbound_mark",
        lifecycle_status="active",
    ):
        receipt_id = {
            ("shipment-a", "warehouse-1"): "receipt-a",
            ("shipment-a", "warehouse-2"): "receipt-a-w2",
            ("shipment-b", "warehouse-1"): "receipt-b",
            ("shipment-x", "warehouse-x"): "receipt-x",
        }[(shipment_id, warehouse_id)]
        organization_id = "org-2" if shipment_id == "shipment-x" else "org-1"
        location_id = {
            "warehouse-1": "location-1",
            "warehouse-2": "location-2",
            "warehouse-x": "location-x",
        }[warehouse_id]
        self.db.execute(
            """INSERT INTO warehouse_packages(
                 id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,
                 barcode,package_number,status,created_at,updated_at,label_kind,lifecycle_status
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                package_id,
                organization_id,
                receipt_id,
                shipment_id,
                warehouse_id,
                location_id,
                package_id,
                package_id,
                "in_stock" if label_kind == "inbound_mark" else "allocated",
                "2026-09-08T00:00:00Z",
                "2026-09-08T00:00:00Z",
                label_kind,
                lifecycle_status,
            ),
        )

    def add_batch(
        self,
        batch_id="packing-a",
        order_id="order-a",
        dispatch_id="dispatch-ftl-a",
        source_type="ftl_order",
        transport_batch_id=None,
        warehouse_id="warehouse-1",
        source_count=2,
        outbound_count=1,
        revision=1,
    ):
        self.db.execute(
            """INSERT INTO warehouse_packing_batches(
                 id,organization_id,warehouse_id,order_id,transport_batch_id,dispatch_id,
                 source_type,packing_mode,source_package_count,outbound_package_count,
                 total_weight_kg,total_volume_cbm,revision,status,created_at,updated_at
               ) VALUES(?,?,?,?,?,?,?,'merge',?,?,12.5,0.8,?,'generated',?,?)""",
            (
                batch_id,
                "org-1",
                warehouse_id,
                order_id,
                transport_batch_id,
                dispatch_id,
                source_type,
                source_count,
                outbound_count,
                revision,
                "2026-09-08T00:00:00Z",
                "2026-09-08T00:00:00Z",
            ),
        )

    def add_source(self, row_id, batch_id, package_id):
        self.db.execute(
            "INSERT INTO warehouse_packing_batch_sources VALUES(?,?,?,?,?)",
            (row_id, "org-1", batch_id, package_id, "2026-09-08T00:00:00Z"),
        )

    def attach_oul(self, package_id, batch_id, shipment_id="shipment-a", warehouse_id="warehouse-1"):
        self.add_package(package_id, shipment_id, warehouse_id, "oul")
        self.db.execute(
            "UPDATE warehouse_packages SET packing_batch_id=? WHERE id=?",
            (batch_id, package_id),
        )

    def test_allows_order_level_sources_and_arbitrary_order_owned_ouls(self):
        self.add_package("in-a-1")
        self.add_package("in-a-2")
        self.add_batch(outbound_count=3)
        self.add_source("source-1", "packing-a", "in-a-1")
        self.add_source("source-2", "packing-a", "in-a-2")
        for sequence in range(1, 4):
            package_id = f"oul-a-{sequence}"
            self.attach_oul(package_id, "packing-a")
            self.db.execute(
                "INSERT INTO warehouse_dispatch_items VALUES(?,?,?,?,?)",
                (f"item-{sequence}", "org-1", "dispatch-ftl-a", package_id, "pending"),
            )
        self.db.execute(
            "UPDATE warehouse_packing_batches SET status='printed' WHERE id='packing-a'"
        )
        self.assertEqual(
            self.db.execute(
                "SELECT source_package_count,outbound_package_count,status FROM warehouse_packing_batches"
            ).fetchone(),
            (2, 3, "printed"),
        )

    def test_rejects_invalid_source_ownership_warehouse_and_kind(self):
        self.add_package("in-a")
        self.add_package("in-b", "shipment-b")
        self.add_package("in-a-w2", "shipment-a", "warehouse-2")
        self.add_package("not-inbound", label_kind="oul")
        self.add_batch(source_count=1)
        for package_id in ("in-b", "in-a-w2", "not-inbound"):
            with self.subTest(package_id=package_id), self.assertRaises(sqlite3.IntegrityError):
                self.add_source(f"source-{package_id}", "packing-a", package_id)
        self.add_source("source-valid", "packing-a", "in-a")

    def test_rejects_invalid_oul_ownership_warehouse_and_kind(self):
        self.add_package("in-a")
        self.add_batch(source_count=1)
        self.add_source("source-a", "packing-a", "in-a")
        for package_id, shipment_id, warehouse_id, label_kind in (
            ("oul-order-b", "shipment-b", "warehouse-1", "oul"),
            ("oul-warehouse-2", "shipment-a", "warehouse-2", "oul"),
            ("oul-wrong-kind", "shipment-a", "warehouse-1", "inbound_mark"),
        ):
            self.add_package(package_id, shipment_id, warehouse_id, label_kind)
            with self.subTest(package_id=package_id), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(
                    "UPDATE warehouse_packages SET packing_batch_id='packing-a' WHERE id=?",
                    (package_id,),
                )

    def test_rejects_invalid_ftl_and_pz_scope(self):
        invalid = (
            dict(batch_id="ftl-with-pz", transport_batch_id="pz-1"),
            dict(batch_id="ftl-wrong-order", order_id="order-b"),
            dict(batch_id="pz-without-batch", source_type="pz_order", dispatch_id="dispatch-pz"),
            dict(batch_id="pz-removed-order", source_type="pz_order", transport_batch_id="pz-2", dispatch_id="dispatch-pz-w2"),
            dict(batch_id="pz-wrong-dispatch", source_type="pz_order", transport_batch_id="pz-1", dispatch_id="dispatch-ftl-a"),
        )
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(sqlite3.IntegrityError):
                self.add_batch(source_count=1, **values)
        self.add_batch(
            batch_id="packing-pz-b",
            order_id="order-b",
            dispatch_id="dispatch-pz",
            source_type="pz_order",
            transport_batch_id="pz-1",
            source_count=1,
        )

    def test_rejects_identity_updates_and_multiple_active_versions(self):
        self.add_package("in-a")
        self.add_batch(source_count=1)
        self.add_source("source-a", "packing-a", "in-a")
        for sql in (
            "UPDATE warehouse_packing_batches SET order_id='order-b' WHERE id='packing-a'",
            "UPDATE warehouse_packing_batch_sources SET inbound_warehouse_package_id='missing' WHERE id='source-a'",
            "UPDATE warehouse_packages SET shipment_id='shipment-b' WHERE id='in-a'",
        ):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_batch(batch_id="packing-a-v2", source_count=1, revision=2)
        self.db.execute("UPDATE warehouse_packing_batches SET status='cancelled' WHERE id='packing-a'")
        self.add_batch(batch_id="packing-a-v2", source_count=1, revision=2)

    def test_rejects_invalid_measures_counts_states_and_incomplete_ready_batch(self):
        invalid_sql = (
            """INSERT INTO warehouse_packing_batches(
                 id,organization_id,warehouse_id,order_id,dispatch_id,source_type,packing_mode,
                 source_package_count,outbound_package_count,total_weight_kg,revision,status,created_at,updated_at
               ) VALUES('bad-weight','org-1','warehouse-1','order-a','dispatch-ftl-a','ftl_order','merge',1,1,0,1,'generated','x','x')""",
            """INSERT INTO warehouse_packing_batches(
                 id,organization_id,warehouse_id,order_id,dispatch_id,source_type,packing_mode,
                 source_package_count,outbound_package_count,revision,status,created_at,updated_at
               ) VALUES('bad-count','org-1','warehouse-1','order-a','dispatch-ftl-a','ftl_order','merge',1,0,1,'generated','x','x')""",
            """INSERT INTO warehouse_packing_batches(
                 id,organization_id,warehouse_id,order_id,dispatch_id,source_type,packing_mode,
                 source_package_count,outbound_package_count,revision,status,created_at,updated_at
               ) VALUES('bad-state','org-1','warehouse-1','order-a','dispatch-ftl-a','ftl_order','merge',1,1,1,'ready','x','x')""",
        )
        for sql in invalid_sql:
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)
        self.add_batch(source_count=1, outbound_count=1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE warehouse_packing_batches SET status='printed' WHERE id='packing-a'")


if __name__ == "__main__":
    unittest.main()
