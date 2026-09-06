import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0137_warehouse_dispatch_completion_integrity.sql"


class WarehouseDispatchCompletionIntegrityMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(
            """
            CREATE TABLE warehouse_dispatches(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL,
              status TEXT NOT NULL
            );
            CREATE TABLE warehouse_packages(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL,
              warehouse_id TEXT
            );
            CREATE TABLE warehouse_dispatch_items(
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL,
              dispatch_id TEXT NOT NULL,
              package_id TEXT NOT NULL
            );
            """
        )
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def add_dispatch(self, dispatch_id, packages):
        self.db.execute(
            "INSERT INTO warehouse_dispatches VALUES(?, 'org-1', 'loading')",
            (dispatch_id,),
        )
        for index, (organization_id, warehouse_id) in enumerate(packages):
            package_id = f"{dispatch_id}-package-{index}"
            self.db.execute(
                "INSERT INTO warehouse_packages VALUES(?,?,?)",
                (package_id, organization_id, warehouse_id),
            )
            self.db.execute(
                "INSERT INTO warehouse_dispatch_items VALUES(?,?,?,?)",
                (f"{dispatch_id}-item-{index}", organization_id, dispatch_id, package_id),
            )

    def complete(self, dispatch_id):
        self.db.execute(
            "UPDATE warehouse_dispatches SET status='dispatched' WHERE id=? AND status='loading'",
            (dispatch_id,),
        )

    def test_allows_one_organization_and_one_warehouse(self):
        self.add_dispatch("valid", [("org-1", "warehouse-1"), ("org-1", "warehouse-1")])
        self.complete("valid")
        self.assertEqual(
            self.db.execute("SELECT status FROM warehouse_dispatches WHERE id='valid'").fetchone()[0],
            "dispatched",
        )

    def test_blocks_empty_cross_organization_cross_warehouse_and_null_warehouse(self):
        cases = {
            "empty": [],
            "cross-org": [("org-2", "warehouse-1")],
            "cross-warehouse": [("org-1", "warehouse-1"), ("org-1", "warehouse-2")],
            "null-warehouse": [("org-1", None)],
        }
        for dispatch_id, packages in cases.items():
            with self.subTest(dispatch_id=dispatch_id):
                self.add_dispatch(dispatch_id, packages)
                with self.assertRaises(sqlite3.IntegrityError):
                    self.complete(dispatch_id)
                self.assertEqual(
                    self.db.execute(
                        "SELECT status FROM warehouse_dispatches WHERE id=?", (dispatch_id,)
                    ).fetchone()[0],
                    "loading",
                )


if __name__ == "__main__":
    unittest.main()
