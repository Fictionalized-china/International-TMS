import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0147_require_domestic_receiving_measurements.sql"


class DomesticReceivingMeasurementsMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(
            """
            CREATE TABLE workflow_step_fields(
              id TEXT PRIMARY KEY, module_code TEXT, field_key TEXT, label TEXT,
              help_text TEXT, is_required INTEGER, is_active INTEGER, updated_at TEXT
            );
            CREATE TABLE workflow_instance_fields(
              id TEXT PRIMARY KEY, instance_id TEXT, step_key TEXT, module_code TEXT,
              field_key TEXT, label TEXT, help_text TEXT, is_required INTEGER, is_active INTEGER
            );
            CREATE TABLE workflow_instance_step_states(
              id TEXT PRIMARY KEY, instance_id TEXT, step_key TEXT, status TEXT
            );

            INSERT INTO workflow_step_fields VALUES
              ('weight','warehouse','actual_weight_kg','实收重量KG','old',0,1,'old'),
              ('volume','warehouse','actual_volume_cbm','收货实测体积（旧）','old',0,0,'old');

            INSERT INTO workflow_instance_step_states VALUES
              ('state-current','current','warehouse_receiving','in_progress'),
              ('state-future','future','warehouse_receiving','pending'),
              ('state-complete','complete','warehouse_receiving','completed');

            INSERT INTO workflow_instance_fields VALUES
              ('current-weight','current','warehouse_receiving','warehouse','actual_weight_kg','实收重量KG','old',0,1),
              ('current-volume','current','warehouse_receiving','warehouse','actual_volume_cbm','旧体积','old',0,0),
              ('future-weight','future','warehouse_receiving','warehouse','actual_weight_kg','实收重量KG','old',0,1),
              ('future-volume','future','warehouse_receiving','warehouse','actual_volume_cbm','旧体积','old',0,0),
              ('complete-weight','complete','warehouse_receiving','warehouse','actual_weight_kg','历史重量','old',0,1),
              ('complete-volume','complete','warehouse_receiving','warehouse','actual_volume_cbm','历史体积','old',0,0);
            """
        )
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def test_definitions_require_both_measurements(self):
        rows = self.db.execute(
            "SELECT field_key,is_required,is_active,label FROM workflow_step_fields ORDER BY field_key"
        ).fetchall()
        self.assertEqual(rows, [
            ("actual_volume_cbm", 1, 1, "实收总体积CBM"),
            ("actual_weight_kg", 1, 1, "实收重量KG"),
        ])

    def test_current_and_future_instances_update_but_completed_history_is_frozen(self):
        current = self.db.execute(
            "SELECT field_key,is_required,is_active FROM workflow_instance_fields WHERE instance_id='current' ORDER BY field_key"
        ).fetchall()
        future = self.db.execute(
            "SELECT field_key,is_required,is_active FROM workflow_instance_fields WHERE instance_id='future' ORDER BY field_key"
        ).fetchall()
        complete = self.db.execute(
            "SELECT field_key,is_required,is_active,label FROM workflow_instance_fields WHERE instance_id='complete' ORDER BY field_key"
        ).fetchall()
        self.assertEqual(current, [("actual_volume_cbm", 1, 1), ("actual_weight_kg", 1, 1)])
        self.assertEqual(future, [("actual_volume_cbm", 1, 1), ("actual_weight_kg", 1, 1)])
        self.assertEqual(complete, [
            ("actual_volume_cbm", 0, 0, "历史体积"),
            ("actual_weight_kg", 0, 1, "历史重量"),
        ])


if __name__ == "__main__":
    unittest.main()
