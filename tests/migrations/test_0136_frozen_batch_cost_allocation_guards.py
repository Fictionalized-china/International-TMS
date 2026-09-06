from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0136_frozen_batch_cost_allocation_guards.sql"


SCHEMA = """
CREATE TABLE transport_batches(id TEXT PRIMARY KEY,organization_id TEXT,batch_number TEXT,status TEXT,approval_status TEXT,actual_departure_at TEXT);
CREATE TABLE transport_batch_orders(id TEXT PRIMARY KEY,organization_id TEXT,batch_id TEXT,order_id TEXT,sequence_no INTEGER,status TEXT);
CREATE TABLE transport_orders(id TEXT PRIMARY KEY,organization_id TEXT,order_number TEXT,business_type TEXT,status TEXT,workflow_instance_id TEXT);
CREATE TABLE workflow_instances(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,status TEXT,current_step_key TEXT);
CREATE TABLE workflow_instance_step_states(id TEXT PRIMARY KEY,instance_id TEXT,step_key TEXT,step_name TEXT,sort_order INTEGER,status TEXT);
CREATE TABLE workflow_instance_module_states(id TEXT PRIMARY KEY,instance_step_state_id TEXT,module_code TEXT,status TEXT);
CREATE TABLE workflow_instance_fields(id TEXT PRIMARY KEY,instance_id TEXT,module_code TEXT,field_key TEXT,step_key TEXT,is_active INTEGER,is_required INTEGER,sort_order INTEGER);
CREATE TABLE order_module_instances(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,module_code TEXT,enabled INTEGER,status TEXT);
CREATE TABLE order_expense_direction_controls(organization_id TEXT,order_id TEXT,direction TEXT,confirmed INTEGER DEFAULT 0,business_reviewed INTEGER DEFAULT 0,finance_reviewed INTEGER DEFAULT 0,business_locked INTEGER DEFAULT 0,finance_locked INTEGER DEFAULT 0);
CREATE TABLE warehouse_dispatches(id TEXT PRIMARY KEY,organization_id TEXT,transport_batch_id TEXT,status TEXT);
CREATE TABLE warehouse_dispatch_items(id TEXT PRIMARY KEY,organization_id TEXT,dispatch_id TEXT,package_id TEXT);
CREATE TABLE warehouse_packages(id TEXT PRIMARY KEY,organization_id TEXT,shipment_id TEXT);
CREATE TABLE shipments(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT);
CREATE TABLE order_tracking_milestones(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,milestone_code TEXT);
CREATE TABLE business_expenses(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,direction TEXT,stage TEXT,source_type TEXT,source_id TEXT);
CREATE UNIQUE INDEX expense_source ON business_expenses(organization_id,source_type,source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE TABLE transport_cost_allocations(
 id TEXT PRIMARY KEY,organization_id TEXT,batch_id TEXT,charge_code TEXT,charge_name TEXT,counterparty_name TEXT,currency TEXT,exchange_rate REAL,total_amount REAL CHECK(total_amount>0),allocation_method TEXT,total_actual_weight_kg REAL CHECK(total_actual_weight_kg>=0),total_actual_volume_cbm REAL CHECK(total_actual_volume_cbm>=0),density_kg_per_cbm REAL CHECK(density_kg_per_cbm>=0),density_result TEXT,status TEXT,notes TEXT,created_by_user_id TEXT,confirmed_by_user_id TEXT,confirmed_at TEXT,created_at TEXT,updated_at TEXT
);
CREATE TABLE transport_cost_allocation_lines(
 id TEXT PRIMARY KEY,organization_id TEXT,allocation_id TEXT,order_id TEXT,actual_weight_kg REAL CHECK(actual_weight_kg>=0),actual_volume_cbm REAL CHECK(actual_volume_cbm>=0),suggested_ratio REAL CHECK(suggested_ratio>=0),suggested_amount REAL CHECK(suggested_amount>=0),adjusted_amount REAL,adjustment_reason TEXT,final_amount REAL CHECK(final_amount>=0),expense_id TEXT,created_at TEXT,updated_at TEXT,UNIQUE(allocation_id,order_id)
);
"""


class FrozenBatchCostAllocationGuardsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA)
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))
        self.seed_order("order-1", "wi-1")

    def tearDown(self):
        self.db.close()

    def seed_order(self, order_id: str, instance_id: str):
        suffix = order_id
        self.db.execute("INSERT OR IGNORE INTO transport_batches VALUES('batch-1','org-1','PZ-001','loading','approved',NULL)")
        self.db.execute("INSERT INTO transport_orders VALUES(?,?,?,?,?,?)", (order_id, "org-1", f"SO-{suffix}", "ltl", "in_execution", instance_id))
        self.db.execute("INSERT INTO transport_batch_orders VALUES(?,?,?,?,?,?)", (f"bo-{suffix}", "org-1", "batch-1", order_id, 1, "assigned"))
        self.db.execute("INSERT INTO workflow_instances VALUES(?,?,?,?,?)", (instance_id, "org-1", order_id, "active", "outbound"))
        self.db.executemany("INSERT INTO workflow_instance_step_states VALUES(?,?,?,?,?,?)", [
            (f"loading-{suffix}", instance_id, "loading", "配载装车", 60, "completed"),
            (f"outbound-{suffix}", instance_id, "outbound", "装车出库", 70, "active"),
            (f"cost-{suffix}", instance_id, "settlement", "费用结算", 100, "pending"),
        ])
        self.db.executemany("INSERT INTO workflow_instance_module_states VALUES(?,?,?,?)", [
            (f"loading-module-{suffix}", f"loading-{suffix}", "loading", "completed"),
            (f"cost-module-{suffix}", f"cost-{suffix}", "costs", "pending"),
        ])
        self.db.execute("INSERT INTO workflow_instance_fields VALUES(?,?,?,?,?,?,?,?)", (f"field-{suffix}", instance_id, "loading", "cost_allocation", "loading", 1, 0, 10))
        self.db.execute("INSERT INTO order_module_instances VALUES(?,?,?,?,?,?)", (f"cost-instance-{suffix}", "org-1", order_id, "costs", 1, "in_progress"))
        self.db.execute("INSERT INTO shipments VALUES(?,?,?)", (f"shipment-{suffix}", "org-1", order_id))
        self.db.execute("INSERT INTO warehouse_packages VALUES(?,?,?)", (f"package-{suffix}", "org-1", f"shipment-{suffix}"))
        self.db.execute("INSERT INTO warehouse_dispatches VALUES(?,?,?,?)", (f"dispatch-{suffix}", "org-1", "batch-1", "dispatched"))
        self.db.execute("INSERT INTO warehouse_dispatch_items VALUES(?,?,?,?)", (f"item-{suffix}", "org-1", f"dispatch-{suffix}", f"package-{suffix}"))

    def insert_header(self, allocation_id="allocation-1", organization_id="org-1"):
        self.db.execute("""INSERT INTO transport_cost_allocations VALUES(
          ?,?,'batch-1','FREIGHT','运费','承运商','CNY',1,100,'equal',100,1,100,'重货','draft',NULL,'user-1',NULL,NULL,'now','now')""", (allocation_id, organization_id))

    def insert_line(self, allocation_id="allocation-1", order_id="order-1", organization_id="org-1"):
        self.db.execute("""INSERT INTO transport_cost_allocation_lines VALUES(
          'line-1',?,?,?,100,1,1,100,NULL,NULL,100,NULL,'now','now')""", (organization_id, allocation_id, order_id))

    def test_header_requires_same_org_approved_pz_before_exit(self):
        self.db.execute("UPDATE transport_batches SET approval_status='submitted' WHERE id='batch-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "未审核"):
            self.insert_header()
        self.db.execute("UPDATE transport_batches SET approval_status='approved',actual_departure_at='now' WHERE id='batch-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "实际出境"):
            self.insert_header("allocation-2")

    def test_line_requires_exact_frozen_field_dispatch_and_same_org(self):
        self.insert_header()
        self.db.execute("UPDATE workflow_instance_fields SET module_code='customs' WHERE id='field-order-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "冻结"):
            self.insert_line()
        self.db.execute("UPDATE workflow_instance_fields SET module_code='loading' WHERE id='field-order-1'")
        self.db.execute("DELETE FROM warehouse_dispatch_items")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "出库"):
            self.insert_line()
        self.db.execute("INSERT INTO warehouse_dispatch_items VALUES('item-order-1','org-1','dispatch-order-1','package-order-1')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_line(organization_id="org-2")
        self.insert_line()

    def test_confirmed_header_and_lines_are_immutable_and_double_confirm_is_rejected(self):
        self.insert_header()
        self.insert_line()
        self.db.execute("INSERT INTO business_expenses VALUES('expense-1','org-1','order-1','payable','estimated','loading_cost_allocation_line','line-1')")
        self.db.execute("UPDATE transport_cost_allocation_lines SET expense_id='expense-1' WHERE id='line-1'")
        self.db.execute("UPDATE transport_cost_allocations SET status='confirmed',confirmed_by_user_id='user-1',confirmed_at='now' WHERE id='allocation-1' AND status='draft'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不可修改|草稿"):
            self.db.execute("UPDATE transport_cost_allocation_lines SET final_amount=90 WHERE id='line-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不可修改"):
            self.db.execute("UPDATE transport_cost_allocations SET total_amount=90 WHERE id='allocation-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "确认条件"):
            self.db.execute("UPDATE transport_cost_allocations SET status='confirmed' WHERE id='allocation-1'")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM business_expenses").fetchone()[0], 1)

    def test_newly_mounted_order_does_not_inherit_and_blocks_confirmation(self):
        self.insert_header()
        self.insert_line()
        self.seed_order("order-2", "wi-2")
        self.db.execute("INSERT INTO business_expenses VALUES('expense-1','org-1','order-1','payable','estimated','loading_cost_allocation_line','line-1')")
        self.db.execute("UPDATE transport_cost_allocation_lines SET expense_id='expense-1' WHERE id='line-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "记录不完整"):
            self.db.execute("UPDATE transport_cost_allocations SET status='confirmed',confirmed_by_user_id='user-1',confirmed_at='now' WHERE id='allocation-1'")

    def test_actual_exit_race_blocks_expense_creation_before_any_ledger_write(self):
        self.insert_header()
        self.insert_line()
        self.db.execute("UPDATE transport_batches SET actual_departure_at='now' WHERE id='batch-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "确认分摊"):
            self.db.execute("INSERT INTO business_expenses VALUES('expense-1','org-1','order-1','payable','estimated','loading_cost_allocation_line','line-1')")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM business_expenses").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
