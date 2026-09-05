from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0134_repair_quote_generated_cargo_packages.sql"


class QuoteCargoPackageRepairMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE quotations(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              status TEXT NOT NULL, lifecycle_status TEXT NOT NULL,
              pieces INTEGER NOT NULL, gross_weight_kg REAL NOT NULL,
              volume_cbm REAL NOT NULL
            );
            CREATE TABLE transport_orders(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_number TEXT NOT NULL, quotation_id TEXT,
              pieces INTEGER NOT NULL, gross_weight_kg REAL NOT NULL,
              volume_cbm REAL NOT NULL
            );
            CREATE TABLE order_cargo_items(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_id TEXT NOT NULL, line_no INTEGER NOT NULL,
              package_type TEXT NOT NULL, package_count INTEGER NOT NULL,
              pieces_per_package INTEGER NOT NULL,
              gross_weight_per_package_kg REAL NOT NULL,
              net_weight_per_package_kg REAL NOT NULL,
              volume_per_package_cbm REAL NOT NULL,
              notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE order_cargo_packages(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_id TEXT NOT NULL, cargo_item_id TEXT NOT NULL,
              package_code TEXT NOT NULL, package_sequence INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'planned', created_at TEXT NOT NULL,
              UNIQUE(order_id,package_code),
              UNIQUE(cargo_item_id,package_sequence)
            );
            CREATE TABLE order_workflow_history(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_id TEXT NOT NULL, action_code TEXT NOT NULL
            );
            CREATE TABLE warehouse_receipt_items(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_id TEXT NOT NULL, cargo_item_id TEXT NOT NULL
            );
            CREATE TABLE shipments(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_id TEXT NOT NULL
            );
            CREATE TABLE warehouse_packages(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              shipment_id TEXT NOT NULL, cargo_item_id TEXT
            );
            CREATE TABLE transport_vehicle_loads(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              package_id TEXT NOT NULL
            );
            """
        )

    def tearDown(self) -> None:
        self.connection.close()

    def seed_candidate(
        self,
        suffix: str,
        *,
        pieces: int = 3,
        quote_status: str = "accepted",
        lifecycle_status: str = "accepted",
        notes: str = "由已接受报价自动生成",
        package_status: str = "planned",
        quote_pieces: int | None = None,
        with_history: bool = True,
    ) -> tuple[str, str, str]:
        organization_id = "org-1"
        quote_id = f"quote-{suffix}"
        order_id = f"order-{suffix}"
        item_id = f"item-{suffix}"
        package_id = f"package-{suffix}-1"
        order_number = f"SO-{suffix}"
        self.connection.execute(
            "INSERT INTO quotations VALUES(?,?,?,?,?,?,?)",
            (
                quote_id, organization_id, quote_status, lifecycle_status,
                pieces if quote_pieces is None else quote_pieces, 120.0, 6.0,
            ),
        )
        self.connection.execute(
            "INSERT INTO transport_orders VALUES(?,?,?,?,?,?,?)",
            (order_id, organization_id, order_number, quote_id, pieces, 120.0, 6.0),
        )
        self.connection.execute(
            "INSERT INTO order_cargo_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                item_id, organization_id, order_id, 1, "other", 1, pieces,
                120.0, 120.0, 6.0, notes,
                "2026-09-05T12:00:00.000Z", "2026-09-05T12:00:00.000Z",
            ),
        )
        self.connection.execute(
            "INSERT INTO order_cargo_packages VALUES(?,?,?,?,?,?,?,?)",
            (
                package_id, organization_id, order_id, item_id,
                f"{order_number}-P001", 1, package_status,
                "2026-09-05T12:00:00.000Z",
            ),
        )
        if with_history:
            self.connection.execute(
                "INSERT INTO order_workflow_history VALUES(?,?,?,?)",
                (
                    f"history-{suffix}", organization_id, order_id,
                    "quote_accepted_auto_create",
                ),
            )
        return order_id, item_id, package_id

    def apply_migration(self) -> None:
        self.connection.executescript(MIGRATION.read_text(encoding="utf-8"))

    def cargo_shape(self, item_id: str) -> tuple[object, ...]:
        row = self.connection.execute(
            """SELECT package_count,pieces_per_package,
                      gross_weight_per_package_kg,net_weight_per_package_kg,
                      volume_per_package_cbm
                 FROM order_cargo_items WHERE id=?""",
            (item_id,),
        ).fetchone()
        return tuple(row)

    def test_repairs_totals_and_rebuilds_one_package_definition_per_piece(self) -> None:
        _, item_id, old_package_id = self.seed_candidate("repair", pieces=3)

        self.apply_migration()

        shape = self.cargo_shape(item_id)
        self.assertEqual(shape[:2], (3, 1))
        self.assertAlmostEqual(shape[2], 40.0)
        self.assertAlmostEqual(shape[3], 40.0)
        self.assertAlmostEqual(shape[4], 2.0)
        packages = [
            tuple(row)
            for row in self.connection.execute(
                """SELECT package_code,package_sequence,status,created_at
                     FROM order_cargo_packages WHERE cargo_item_id=?
                     ORDER BY package_sequence""",
                (item_id,),
            )
        ]
        self.assertEqual(
            packages,
            [
                ("SO-repair-P001", 1, "planned", "2026-09-05T12:00:00.000Z"),
                ("SO-repair-P002", 2, "planned", "2026-09-05T12:00:00.000Z"),
                ("SO-repair-P003", 3, "planned", "2026-09-05T12:00:00.000Z"),
            ],
        )
        self.assertIsNone(
            self.connection.execute(
                "SELECT 1 FROM order_cargo_packages WHERE id=?", (old_package_id,)
            ).fetchone()
        )
        self.assertAlmostEqual(shape[0] * shape[2], 120.0)
        self.assertAlmostEqual(shape[0] * shape[4], 6.0)
        self.assertIsNone(
            self.connection.execute(
                """SELECT 1 FROM sqlite_master
                    WHERE type='table'
                      AND name='migration_0134_quote_cargo_targets'"""
            ).fetchone()
        )

    def test_is_idempotent_after_successful_repair(self) -> None:
        _, item_id, _ = self.seed_candidate("idempotent", pieces=4)
        self.apply_migration()
        first_shape = self.cargo_shape(item_id)
        first_packages = [
            tuple(row)
            for row in self.connection.execute(
                """SELECT id,package_code,package_sequence,status,created_at
                     FROM order_cargo_packages WHERE cargo_item_id=?
                     ORDER BY package_sequence""",
                (item_id,),
            )
        ]

        self.apply_migration()

        self.assertEqual(self.cargo_shape(item_id), first_shape)
        self.assertEqual(
            [
                tuple(row)
                for row in self.connection.execute(
                    """SELECT id,package_code,package_sequence,status,created_at
                         FROM order_cargo_packages WHERE cargo_item_id=?
                         ORDER BY package_sequence""",
                    (item_id,),
                )
            ],
            first_packages,
        )

    def test_skips_any_order_with_receipt_or_warehouse_package(self) -> None:
        receipt_order, receipt_item, _ = self.seed_candidate("receipt")
        warehouse_order, warehouse_item, _ = self.seed_candidate("warehouse")
        self.connection.execute(
            "INSERT INTO warehouse_receipt_items VALUES(?,?,?,?)",
            ("receipt-1", "org-1", receipt_order, receipt_item),
        )
        self.connection.execute(
            "INSERT INTO shipments VALUES(?,?,?)",
            ("shipment-1", "org-1", warehouse_order),
        )
        self.connection.execute(
            "INSERT INTO warehouse_packages VALUES(?,?,?,?)",
            ("warehouse-package-1", "org-1", "shipment-1", warehouse_item),
        )

        self.apply_migration()

        self.assertEqual(self.cargo_shape(receipt_item)[:2], (1, 3))
        self.assertEqual(self.cargo_shape(warehouse_item)[:2], (1, 3))

    def test_skips_any_order_with_load_reference_or_nonplanned_package(self) -> None:
        _, loaded_item, loaded_package = self.seed_candidate("load")
        _, status_item, _ = self.seed_candidate("status", package_status="loaded")
        self.connection.execute(
            "INSERT INTO transport_vehicle_loads VALUES(?,?,?)",
            ("load-1", "org-1", loaded_package),
        )

        self.apply_migration()

        self.assertEqual(self.cargo_shape(loaded_item)[:2], (1, 3))
        self.assertEqual(self.cargo_shape(status_item)[:2], (1, 3))

    def test_skips_more_than_the_safe_five_hundred_package_limit(self) -> None:
        _, item_id, old_package_id = self.seed_candidate("over-limit", pieces=501)

        self.apply_migration()

        self.assertEqual(self.cargo_shape(item_id)[:2], (1, 501))
        self.assertIsNotNone(
            self.connection.execute(
                "SELECT 1 FROM order_cargo_packages WHERE id=?", (old_package_id,)
            ).fetchone()
        )

    def test_skips_records_without_the_exact_automatic_creation_fingerprint(self) -> None:
        _, manual_item, _ = self.seed_candidate("manual", notes="人工维护")
        _, withdrawn_item, _ = self.seed_candidate(
            "withdrawn", quote_status="expired", lifecycle_status="withdrawn"
        )
        _, mismatch_item, _ = self.seed_candidate("mismatch", quote_pieces=2)
        _, no_history_item, _ = self.seed_candidate("no-history", with_history=False)
        extra_order, extra_item, _ = self.seed_candidate("extra-item")
        self.connection.execute(
            "INSERT INTO order_cargo_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "item-extra-sibling", "org-1", extra_order, 2, "other", 1, 1,
                1.0, 1.0, 0.1, "人工追加",
                "2026-09-05T12:00:00.000Z", "2026-09-05T12:00:00.000Z",
            ),
        )

        self.apply_migration()

        for item_id in (
            manual_item, withdrawn_item, mismatch_item, no_history_item, extra_item
        ):
            with self.subTest(item_id=item_id):
                self.assertEqual(self.cargo_shape(item_id)[:2], (1, 3))


if __name__ == "__main__":
    unittest.main()
