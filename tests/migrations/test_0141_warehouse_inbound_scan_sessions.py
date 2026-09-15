import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0141_warehouse_inbound_scan_sessions.sql"


class WarehouseInboundScanSessionsMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(
            """
            CREATE TABLE organizations(id TEXT PRIMARY KEY);
            CREATE TABLE users(id TEXT PRIMARY KEY);
            CREATE TABLE warehouses(id TEXT PRIMARY KEY);
            CREATE TABLE transport_orders(id TEXT PRIMARY KEY, organization_id TEXT);
            CREATE TABLE shipments(id TEXT PRIMARY KEY, organization_id TEXT, order_id TEXT);
            CREATE TABLE warehouse_receipts(
              id TEXT PRIMARY KEY, organization_id TEXT, warehouse_id TEXT, status TEXT
            );
            CREATE TABLE order_cargo_packages(
              id TEXT PRIMARY KEY, organization_id TEXT, order_id TEXT,
              is_active INTEGER, status TEXT
            );
            INSERT INTO organizations VALUES('org-1');
            INSERT INTO users VALUES('user-1');
            INSERT INTO warehouses VALUES('warehouse-1');
            INSERT INTO warehouses VALUES('warehouse-2');
            INSERT INTO transport_orders VALUES('order-1','org-1');
            INSERT INTO transport_orders VALUES('order-2','org-1');
            INSERT INTO shipments VALUES('shipment-1','org-1','order-1');
            INSERT INTO order_cargo_packages VALUES('mark-1','org-1','order-1',1,'planned');
            INSERT INTO order_cargo_packages VALUES('mark-2','org-1','order-2',1,'planned');
            """
        )
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def add_scan_session(self, scan_id="scan-1", warehouse_id="warehouse-1"):
        self.db.execute(
            """INSERT INTO warehouse_inbound_scan_sessions(
                 id,organization_id,warehouse_id,status,opened_by_user_id,opened_at,created_at,updated_at
               ) VALUES(?,?,?,'active','user-1','now','now','now')""",
            (scan_id, "org-1", warehouse_id),
        )

    def add_order_session(self, receiving_id="receiving-1", scan_id="scan-1", order_id="order-1"):
        self.db.execute(
            """INSERT INTO warehouse_inbound_order_receiving_sessions(
                 id,organization_id,warehouse_id,scan_session_id,order_id,status,opened_at,created_at,updated_at
               ) VALUES(?,?, 'warehouse-1',?,?, 'scanning','now','now','now')""",
            (receiving_id, "org-1", scan_id, order_id),
        )

    def add_event(self, event_id="event-1", scan_id="scan-1", mark_id="mark-1", order_id="order-1", receiving_id="receiving-1"):
        self.db.execute(
            """INSERT INTO warehouse_inbound_scan_events(
                 id,organization_id,warehouse_id,scan_session_id,normalized_code,outcome,inbound_mark_id,order_id,order_receiving_session_id,
                 scanned_at,created_at,updated_at
               ) VALUES(?,?, 'warehouse-1',?,'ORDER-1-IN-001','accepted',?,?,?, 'now','now','now')""",
            (event_id, "org-1", scan_id, mark_id, order_id, receiving_id),
        )

    def add_mark_receipt(self, receipt_id="mark-receipt-1", mark_id="mark-1", order_id="order-1", receiving_id="receiving-1", event_id="event-1", status="scanned"):
        self.db.execute(
            """INSERT INTO warehouse_inbound_mark_receipts(
                 id,organization_id,warehouse_id,inbound_mark_id,order_id,order_receiving_session_id,
                 first_scan_event_id,status,scanned_at,created_at,updated_at
               ) VALUES(?,?, 'warehouse-1',?,?,?,?,?,'now','now','now')""",
            (receipt_id, "org-1", mark_id, order_id, receiving_id, event_id, status),
        )

    def test_one_active_scanner_per_warehouse(self):
        self.add_scan_session()
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_scan_session("scan-2")
        self.db.execute("UPDATE warehouse_inbound_scan_sessions SET status='closed' WHERE id='scan-1'")
        self.add_scan_session("scan-2")

    def test_order_receiving_session_is_scanner_scoped_and_unique_while_scanning(self):
        self.add_scan_session()
        self.add_order_session()
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_order_session("receiving-2")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_order_session("invalid", "scan-missing")
        self.db.execute("UPDATE warehouse_inbound_order_receiving_sessions SET status='cancelled' WHERE id='receiving-1'")
        self.add_order_session("receiving-2")

    def test_live_mark_receipt_is_unique_and_must_match_order_and_warehouse(self):
        self.add_scan_session()
        self.add_order_session()
        self.add_event()
        self.add_mark_receipt()
        self.add_event("event-2")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_mark_receipt("mark-receipt-2", event_id="event-2")
        self.db.execute("UPDATE warehouse_inbound_mark_receipts SET status='cancelled' WHERE id='mark-receipt-1'")
        self.add_mark_receipt("mark-receipt-2", event_id="event-2")
        self.add_order_session("receiving-3", order_id="order-2")
        self.add_event("event-3", mark_id="mark-2", order_id="order-2", receiving_id="receiving-3")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_mark_receipt("wrong-order", mark_id="mark-1", order_id="order-2", receiving_id="receiving-3", event_id="event-3")

    def test_confirmation_requires_completed_receipt_in_same_warehouse(self):
        self.add_scan_session()
        self.add_order_session()
        self.add_event()
        self.add_mark_receipt()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE warehouse_inbound_mark_receipts SET status='confirmed',receipt_id='missing' WHERE id='mark-receipt-1'")
        self.db.execute("INSERT INTO warehouse_receipts VALUES('receipt-1','org-1','warehouse-1','completed')")
        self.db.execute("UPDATE warehouse_inbound_mark_receipts SET status='confirmed',receipt_id='receipt-1' WHERE id='mark-receipt-1'")


if __name__ == "__main__":
    unittest.main()
