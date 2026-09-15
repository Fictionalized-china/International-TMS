from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0133_expense_mutation_and_batch_allocation_guards.sql"


class ExpenseMutationGuardMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.executescript(
            """
            CREATE TABLE business_expenses(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, order_id TEXT NOT NULL,
              direction TEXT NOT NULL, stage TEXT NOT NULL, charge_code TEXT,
              charge_name TEXT, counterparty_name TEXT, currency TEXT, quantity REAL,
              unit_price REAL, amount REAL, exchange_rate REAL, base_amount REAL,
              notes TEXT, tax_rate REAL, tax_amount REAL, occurred_on TEXT,
              is_internal INTEGER, foreign_account_no TEXT, source_type TEXT, source_id TEXT
            );
            CREATE TABLE transport_orders(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, order_number TEXT NOT NULL,
              status TEXT NOT NULL, workflow_instance_id TEXT
            );
            CREATE TABLE order_expense_direction_controls(
              organization_id TEXT NOT NULL, order_id TEXT NOT NULL, direction TEXT NOT NULL,
              confirmed INTEGER NOT NULL DEFAULT 0,
              business_reviewed INTEGER NOT NULL DEFAULT 0,
              finance_reviewed INTEGER NOT NULL DEFAULT 0,
              business_locked INTEGER NOT NULL DEFAULT 0,
              finance_locked INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE transport_cost_allocations(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              batch_id TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE transport_cost_allocation_lines(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              allocation_id TEXT NOT NULL, order_id TEXT NOT NULL, expense_id TEXT
            );
            CREATE TABLE transport_batch_orders(
              batch_id TEXT NOT NULL, order_id TEXT NOT NULL,
              organization_id TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE workflow_instances(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
              order_id TEXT NOT NULL, current_step_key TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE workflow_instance_step_states(
              id TEXT PRIMARY KEY, instance_id TEXT NOT NULL,
              step_key TEXT NOT NULL, sort_order INTEGER NOT NULL
            );
            CREATE TABLE workflow_instance_module_states(
              id TEXT PRIMARY KEY, instance_step_state_id TEXT NOT NULL,
              module_code TEXT NOT NULL
            );
            CREATE TABLE order_module_instances(
              organization_id TEXT NOT NULL, order_id TEXT NOT NULL,
              module_code TEXT NOT NULL, enabled INTEGER NOT NULL, status TEXT NOT NULL
            );
            """
        )
        self.connection.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self) -> None:
        self.connection.close()

    def seed_open_order(self, *, order_id: str = "order-1", current_sort: int = 70) -> None:
        instance_id = f"instance-{order_id}"
        current_step_id = f"current-{order_id}"
        cost_step_id = f"cost-{order_id}"
        self.connection.execute(
            "INSERT INTO transport_orders VALUES(?,?,?,?,?)",
            (order_id, "org-1", f"SO-{order_id}", "in_execution", instance_id),
        )
        self.connection.execute(
            "INSERT INTO workflow_instances VALUES(?,?,?,?,?)",
            (instance_id, "org-1", order_id, "outbound_transport", "active"),
        )
        self.connection.executemany(
            "INSERT INTO workflow_instance_step_states VALUES(?,?,?,?)",
            [
                (current_step_id, instance_id, "outbound_transport", current_sort),
                (cost_step_id, instance_id, "reconciliation", 100),
            ],
        )
        self.connection.execute(
            "INSERT INTO workflow_instance_module_states VALUES(?,?,?)",
            (f"cost-module-{order_id}", cost_step_id, "costs"),
        )
        self.connection.execute(
            "INSERT INTO order_module_instances VALUES(?,?,?,?,?)",
            ("org-1", order_id, "costs", 1, "in_progress"),
        )

    def insert_expense(
        self,
        expense_id: str,
        order_id: str,
        *,
        source_type: str = "manual",
        source_id: str | None = None,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO business_expenses(
              id,organization_id,order_id,direction,stage,charge_code,charge_name,
              counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
              base_amount,notes,tax_rate,tax_amount,is_internal,source_type,source_id
            ) VALUES(?,?,?,'payable','estimated','FREIGHT','Freight','Carrier','CNY',
                     1,100,100,1,100,'test',0,0,0,?,?)
            """,
            (expense_id, "org-1", order_id, source_type, source_id),
        )

    def test_open_unsigned_direction_allows_normal_expense(self) -> None:
        self.seed_open_order()
        self.insert_expense("expense-open", "order-1")
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM business_expenses").fetchone()[0],
            1,
        )

    def test_signed_direction_blocks_insert(self) -> None:
        self.seed_open_order()
        self.connection.execute(
            "INSERT INTO order_expense_direction_controls VALUES(?,?,?,1,0,0,0,0)",
            ("org-1", "order-1", "payable"),
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能新增费用"):
            self.insert_expense("expense-signed", "order-1")

    def test_terminal_order_blocks_insert_update_and_delete(self) -> None:
        self.seed_open_order()
        self.insert_expense("expense-terminal", "order-1")
        self.connection.execute(
            "UPDATE transport_orders SET status='completed' WHERE id='order-1'"
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能新增费用"):
            self.insert_expense("expense-late", "order-1")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能修改费用"):
            self.connection.execute(
                "UPDATE business_expenses SET amount=101 WHERE id='expense-terminal'"
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能删除费用"):
            self.connection.execute(
                "DELETE FROM business_expenses WHERE id='expense-terminal'"
            )

    def seed_allocation(self, allocation_id: str, line_id: str, order_id: str) -> None:
        self.connection.execute(
            "INSERT INTO transport_cost_allocations VALUES(?,?,?,'draft')",
            (allocation_id, "org-1", "batch-1"),
        )
        self.connection.execute(
            "INSERT INTO transport_batch_orders VALUES(?,?,?,'active')",
            ("batch-1", order_id, "org-1"),
        )
        self.connection.execute(
            "INSERT INTO transport_cost_allocation_lines VALUES(?,?,?,?,NULL)",
            (line_id, "org-1", allocation_id, order_id),
        )

    def test_valid_loading_allocation_insert_is_allowed(self) -> None:
        self.seed_open_order()
        self.seed_allocation("allocation-1", "line-1", "order-1")
        self.insert_expense(
            "expense-allocation", "order-1",
            source_type="loading_cost_allocation_line", source_id="line-1",
        )

    def test_loading_allocation_after_cost_node_is_blocked(self) -> None:
        self.seed_open_order(current_sort=110)
        self.seed_allocation("allocation-1", "line-1", "order-1")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能确认分摊"):
            self.insert_expense(
                "expense-late-allocation", "order-1",
                source_type="loading_cost_allocation_line", source_id="line-1",
            )

    def test_loading_allocation_requires_exact_order_instance_binding(self) -> None:
        self.seed_open_order()
        self.connection.execute(
            "UPDATE workflow_instances SET order_id='other-order' WHERE id='instance-order-1'"
        )
        self.seed_allocation("allocation-1", "line-1", "order-1")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能确认分摊"):
            self.insert_expense(
                "expense-cross-order", "order-1",
                source_type="loading_cost_allocation_line", source_id="line-1",
            )

    def test_loading_allocation_requires_active_workflow_instance(self) -> None:
        self.seed_open_order()
        self.connection.execute(
            "UPDATE workflow_instances SET status='completed' WHERE id='instance-order-1'"
        )
        self.seed_allocation("allocation-1", "line-1", "order-1")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "不能确认分摊"):
            self.insert_expense(
                "expense-inactive-instance", "order-1",
                source_type="loading_cost_allocation_line", source_id="line-1",
            )


if __name__ == "__main__":
    unittest.main()
