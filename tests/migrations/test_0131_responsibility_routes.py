from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0131_repair_standard_workflow_responsibility_routes.sql"

OLD_MODULES = (
    ("quotation", "consignment", "询价与报价", 10, 10, 1, 1, "SALES", "all_tasks"),
    ("order_creation", "consignment", "委托信息", 10, 10, 1, 1, "OPERATION", "all_tasks"),
    ("order_creation", "cargo", "货物信息", 270, 270, 0, 1, "OPERATION", "all_tasks"),
    ("order_creation", "costs", "费用结算", 1400, 1400, 0, 0, "FINANCE_ACCOUNTING", "all_tasks"),
    ("consignment_approval", "consignment", "委托信息", 480, 480, 0, 1, "OPERATION", "all_tasks"),
    ("task_assignment", "assignment", "任务分配", 10, 10, 1, 1, "OPERATION_SUPERVISOR", "all_tasks"),
    ("domestic_execution", "transport", "国内运输", 10, 10, 1, 1, "SALES", "all_tasks"),
    ("warehouse_receiving", "warehouse", "仓库入库", 640, 640, 0, 1, "WAREHOUSE", "all_tasks"),
    ("port_loading", "loading", "装车与出库", 10, 900, 1, 1, "LOADING", "all_tasks"),
    ("outbound_transport", "tracking", "运输执行与跟踪", 10, 10, 1, 1, "TRACKING", "all_tasks"),
    ("outbound_transport", "documents", "文件记录", 910, 910, 0, 0, "OPERATION", "all_tasks"),
    ("outbound_transport", "customs", "报关作业", 930, 930, 1, 1, "DOC", "all_tasks"),
    ("overseas_pickup", "overseas_warehouse", "境外仓自提", 10, 10, 1, 1, "OVERSEAS_WAREHOUSE", "all_tasks"),
    ("reconciliation", "costs", "费用结算", 10, 10, 1, 1, "FINANCE_ACCOUNTING", "all_tasks"),
    ("completion_review", "review", "订单复盘", 10, 10, 0, 1, "FINANCE_ACCOUNTING", "all_tasks"),
    ("completion_review", "exceptions", "异常处理", 1280, 1280, 0, 1, "OPERATION", "all_tasks"),
)

OLD_TASKS = (
    ("quotation", "consignment", "handle_quotation", "填写询价并完成报价", "system", "SALES", "首次保存报价时锁定整车或拼车工作流版本；客户接受后完成本节点。"),
    ("order_creation", "consignment", "handle_consignment", "办理委托信息", "form", "OPERATION", None),
    ("order_creation", "cargo", "handle_cargo", "办理货物信息", "form", "OPERATION", None),
    ("order_creation", "costs", "handle_costs", "办理费用结算", "form", "FINANCE_ACCOUNTING", None),
    ("consignment_approval", "consignment", "handle_consignment", "办理委托信息", "form", "OPERATION", None),
    ("task_assignment", "assignment", "handle_assignment", "办理任务分配", "form", "OPERATION_SUPERVISOR", None),
    ("domestic_execution", "transport", "handle_transport", "办理国内运输", "form", "SALES", None),
    ("warehouse_receiving", "warehouse", "handle_warehouse", "办理仓库入库", "form", "WAREHOUSE", None),
    ("port_loading", "loading", "handle_loading", "办理装车与出库", "form", "LOADING", None),
    ("outbound_transport", "tracking", "handle_tracking", "办理运输执行与跟踪", "form", "TRACKING", None),
    ("outbound_transport", "documents", "handle_documents", "办理文件记录", "form", "OPERATION", None),
    ("outbound_transport", "customs", "handle_customs", "办理报关作业", "form", "DOC", None),
    ("overseas_pickup", "overseas_warehouse", "handle_overseas_warehouse", "办理境外仓自提", "form", "OVERSEAS_WAREHOUSE", None),
    ("reconciliation", "costs", "handle_costs", "办理费用结算", "form", "FINANCE_ACCOUNTING", None),
    ("completion_review", "review", "handle_review", "办理订单复盘", "form", "FINANCE_ACCOUNTING", None),
    ("completion_review", "exceptions", "handle_exceptions", "办理异常处理", "form", "OPERATION", None),
)

NEW_MODULES = {
    ("quotation", "consignment"): ("询价与报价", 10, 1, 1, "SALES", "all_tasks"),
    ("order_creation", "consignment"): ("委托信息", 10, 1, 1, "SALES", "all_tasks"),
    ("order_creation", "cargo"): ("货物信息", 20, 0, 1, "SALES", "all_tasks"),
    ("order_creation", "costs"): ("预录费用", 30, 0, 1, "FINANCE_ACCOUNTING", "all_tasks"),
    ("consignment_approval", "consignment"): ("委托审核", 10, 1, 1, "BUSINESS_SUPERVISOR", "manual_confirm"),
    ("task_assignment", "assignment"): ("任务分配", 10, 1, 1, "OPERATION_SUPERVISOR", "all_tasks"),
    ("domestic_execution", "transport"): ("国内运输", 10, 1, 1, "OPERATION", "all_tasks"),
    ("warehouse_receiving", "warehouse"): ("国内仓入库", 10, 1, 1, "WAREHOUSE", "all_tasks"),
    ("port_loading", "loading"): ("装车与出库", 10, 1, 1, "WAREHOUSE", "all_tasks"),
    ("outbound_transport", "documents"): ("报关文件", 10, 0, 1, "DOC", "all_tasks"),
    ("outbound_transport", "customs"): ("报关作业", 20, 1, 1, "DOC", "all_tasks"),
    ("outbound_transport", "tracking"): ("出境运输与运踪", 30, 1, 1, "OPERATION", "all_tasks"),
    ("overseas_pickup", "overseas_warehouse"): ("境外仓与客户自提", 10, 1, 1, "OVERSEAS_WAREHOUSE", "all_tasks"),
    ("reconciliation", "costs"): ("三方费用结算", 10, 1, 1, "CS", "all_tasks"),
    ("completion_review", "exceptions"): ("异常处理", 10, 0, 1, "OPERATION", "all_tasks"),
    ("completion_review", "review"): ("订单复盘", 20, 1, 1, "FINANCE_ACCOUNTING", "manual_confirm"),
}


class ResponsibilityRouteMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE workflow_definitions(
              id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, code TEXT NOT NULL,
              name TEXT NOT NULL, status TEXT NOT NULL, template_family_id TEXT,
              version_number INTEGER NOT NULL, lifecycle_status TEXT NOT NULL,
              based_on_workflow_id TEXT, validation_status TEXT NOT NULL,
              validation_message TEXT, road_load_type TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE workflow_steps(
              id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, step_key TEXT NOT NULL
            );
            CREATE TABLE workflow_step_modules(
              id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, step_id TEXT NOT NULL,
              module_code TEXT NOT NULL, display_name TEXT NOT NULL, sort_order INTEGER NOT NULL,
              is_required INTEGER NOT NULL, is_active INTEGER NOT NULL,
              responsibility_position_code TEXT, completion_mode TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE workflow_module_tasks(
              id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, step_module_id TEXT NOT NULL,
              task_key TEXT NOT NULL, name TEXT NOT NULL, task_type TEXT NOT NULL,
              sort_order INTEGER NOT NULL, is_required INTEGER NOT NULL,
              is_active INTEGER NOT NULL, responsibility_position_code TEXT,
              instructions TEXT, updated_at TEXT NOT NULL
            );
            """
        )

    def tearDown(self) -> None:
        self.connection.close()

    def seed_baseline(
        self,
        organization_id: str,
        code: str,
        *,
        module_deviation: tuple[str, str, str] | None = None,
        extra_module: bool = False,
        task_deviation: tuple[str, str, str] | None = None,
        extra_task: bool = False,
    ) -> str:
        is_ltl = code == "tms-default-v3"
        workflow_id = f"{organization_id}:ltl-v3" if is_ltl else f"{organization_id}:tms-ftl-standard"
        self.connection.execute(
            "INSERT INTO workflow_definitions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                workflow_id,
                organization_id,
                code,
                "拼车型汽运订单标准流程" if is_ltl else "整车型汽运订单标准流程",
                "active",
                f"{organization_id}:tms-default" if is_ltl else workflow_id,
                3 if is_ltl else 1,
                "published",
                None,
                "invalid",
                "保留原校验错误",
                "ltl" if is_ltl else "ftl",
                "before",
            ),
        )
        modules: dict[tuple[str, str], str] = {}
        for (
            step_key,
            module_code,
            display_name,
            ltl_sort,
            ftl_sort,
            required,
            active,
            position,
            completion,
        ) in OLD_MODULES:
            step_id = f"{workflow_id}:step:{step_key}"
            module_id = f"{workflow_id}:module:{step_key}:{module_code}"
            self.connection.execute(
                "INSERT OR IGNORE INTO workflow_steps VALUES(?,?,?)",
                (step_id, workflow_id, step_key),
            )
            if module_deviation and module_deviation[:2] == (step_key, module_code):
                position = module_deviation[2]
            self.connection.execute(
                "INSERT INTO workflow_step_modules VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    module_id,
                    workflow_id,
                    step_id,
                    module_code,
                    display_name,
                    ltl_sort if is_ltl else ftl_sort,
                    required,
                    active,
                    position,
                    completion,
                    "before",
                ),
            )
            modules[(step_key, module_code)] = module_id
        for index, (
            step_key,
            module_code,
            task_key,
            name,
            task_type,
            position,
            instructions,
        ) in enumerate(OLD_TASKS):
            module_id = modules[(step_key, module_code)]
            if task_deviation and task_deviation[:2] == (step_key, module_code):
                position = task_deviation[2]
            self.connection.execute(
                "INSERT INTO workflow_module_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"{module_id}:task:{task_key}",
                    workflow_id,
                    module_id,
                    task_key,
                    name,
                    task_type,
                    10,
                    index % 2,
                    1,
                    position,
                    instructions,
                    "before",
                ),
            )
        if extra_task:
            module_id = modules[("order_creation", "cargo")]
            self.connection.execute(
                "INSERT INTO workflow_module_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"{module_id}:task:user-extra",
                    workflow_id,
                    module_id,
                    "user_extra",
                    "用户额外任务",
                    "form",
                    99,
                    0,
                    1,
                    "SALES",
                    None,
                    "before",
                ),
            )
        if extra_module:
            step_id = f"{workflow_id}:step:order_creation"
            self.connection.execute(
                "INSERT INTO workflow_step_modules VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"{workflow_id}:module:extra",
                    workflow_id,
                    step_id,
                    "extra",
                    "用户额外模块",
                    999,
                    0,
                    1,
                    "SALES",
                    "all_tasks",
                    "before",
                ),
            )
        return workflow_id

    def module_snapshot(self, workflow_id: str) -> list[tuple[object, ...]]:
        return [
            tuple(row)
            for row in self.connection.execute(
                """SELECT step.step_key,module.module_code,module.display_name,module.sort_order,
                          module.is_required,module.is_active,module.responsibility_position_code,
                          module.completion_mode
                     FROM workflow_step_modules module
                     JOIN workflow_steps step ON step.id=module.step_id
                    WHERE module.workflow_id=?
                    ORDER BY step.step_key,module.module_code""",
                (workflow_id,),
            )
        ]

    def test_full_v3_and_ftl_fingerprints_repair_atomically_and_idempotently(self) -> None:
        ltl = self.seed_baseline("org-ltl", "tms-default-v3")
        ftl = self.seed_baseline("org-ftl", "tms-ftl-standard")
        ltl_required_before = dict(
            self.connection.execute(
                "SELECT task_key || ':' || step_module_id,is_required FROM workflow_module_tasks WHERE workflow_id=?",
                (ltl,),
            )
        )
        sql = MIGRATION.read_text(encoding="utf-8")
        self.connection.executescript(sql)

        for workflow_id in (ltl, ftl):
            actual = {
                (row[0], row[1]): tuple(row[2:])
                for row in self.module_snapshot(workflow_id)
            }
            self.assertEqual(actual, NEW_MODULES)
            self.assertEqual(
                self.connection.execute(
                    """SELECT task.responsibility_position_code
                         FROM workflow_module_tasks task
                         JOIN workflow_step_modules module ON module.id=task.step_module_id
                         JOIN workflow_steps step ON step.id=module.step_id
                        WHERE task.workflow_id=? AND step.step_key='reconciliation'
                          AND module.module_code='costs'""",
                    (workflow_id,),
                ).fetchone()[0],
                "CS",
            )
            definition = self.connection.execute(
                "SELECT validation_status,validation_message FROM workflow_definitions WHERE id=?",
                (workflow_id,),
            ).fetchone()
            self.assertEqual(tuple(definition), ("invalid", "保留原校验错误"))

        self.assertEqual(
            dict(
                self.connection.execute(
                    "SELECT task_key || ':' || step_module_id,is_required FROM workflow_module_tasks WHERE workflow_id=?",
                    (ltl,),
                )
            ),
            ltl_required_before,
        )
        changes_after_first_run = self.connection.total_changes
        self.connection.executescript(sql)
        self.assertEqual(self.connection.total_changes, changes_after_first_run)

    def test_any_module_or_task_deviation_skips_the_whole_workflow(self) -> None:
        deviated_module = self.seed_baseline(
            "org-deviated",
            "tms-default-v3",
            module_deviation=("warehouse_receiving", "warehouse", "CUSTOM_WAREHOUSE"),
        )
        extra_module = self.seed_baseline(
            "org-extra",
            "tms-ftl-standard",
            extra_module=True,
        )
        deviated_task = self.seed_baseline(
            "org-task-deviated",
            "tms-default-v3",
            task_deviation=("outbound_transport", "customs", "CUSTOM_DOC"),
        )
        extra_task = self.seed_baseline(
            "org-task-extra",
            "tms-ftl-standard",
            extra_task=True,
        )
        before = {
            workflow_id: self.module_snapshot(workflow_id)
            for workflow_id in (
                deviated_module,
                extra_module,
                deviated_task,
                extra_task,
            )
        }

        self.connection.executescript(MIGRATION.read_text(encoding="utf-8"))

        for workflow_id, snapshot in before.items():
            self.assertEqual(self.module_snapshot(workflow_id), snapshot)
            self.assertEqual(
                self.connection.execute(
                    """SELECT module.responsibility_position_code
                         FROM workflow_step_modules module
                         JOIN workflow_steps step ON step.id=module.step_id
                        WHERE module.workflow_id=? AND step.step_key='domestic_execution'
                          AND module.module_code='transport'""",
                    (workflow_id,),
                ).fetchone()[0],
                "SALES",
            )

    def test_sql_has_no_family_wildcard_or_validation_override(self) -> None:
        normalized = " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())
        self.assertNotIn("template_family_id like", normalized)
        self.assertNotIn("code like", normalized)
        self.assertNotIn("set validation_status", normalized)
        self.assertIn("definition.code='tms-default-v3'", normalized)
        self.assertIn("definition.code='tms-ftl-standard'", normalized)


if __name__ == "__main__":
    unittest.main()
