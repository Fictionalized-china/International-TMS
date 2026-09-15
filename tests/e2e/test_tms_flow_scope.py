from __future__ import annotations

import unittest
from pathlib import Path

from . import tms_full_flow_phase1 as phase1
from . import tms_full_flow_phase2 as phase2
from . import tms_full_flow_phase3 as phase3
from . import tms_full_flow_phase4 as phase4
from .tms_flow_scope import (
    dispatch_keys_for_scope,
    ltl_keys_for_scope,
    normalize_flow_scope,
    order_keys_for_scope,
    phase2_stages_for_scope,
    phase3_stages_for_scope,
)
from .tms_ui_harness import AttemptIdentity


class FlowScopeTests(unittest.TestCase):
    def test_aliases_and_invalid_scope(self) -> None:
        self.assertEqual(normalize_flow_scope("full-truck"), "ftl")
        self.assertEqual(normalize_flow_scope("ltl"), "pz")
        self.assertEqual(normalize_flow_scope("all"), "combined")
        with self.assertRaises(ValueError):
            normalize_flow_scope("unknown")

    def test_ftl_scope_contains_only_one_order_and_dispatch(self) -> None:
        self.assertEqual(order_keys_for_scope("ftl"), ("ftl",))
        self.assertEqual(ltl_keys_for_scope("ftl"), ())
        self.assertEqual(dispatch_keys_for_scope("ftl"), ("ftl",))
        self.assertIn("ftl_loading_outbound", phase2_stages_for_scope("ftl"))
        self.assertNotIn("ltl_consolidation", phase2_stages_for_scope("ftl"))
        self.assertIn("ftl_customs_release", phase3_stages_for_scope("ftl"))
        self.assertNotIn("batch_customs_release", phase3_stages_for_scope("ftl"))

    def test_pz_scope_contains_three_ltl_orders_and_one_batch_dispatch(self) -> None:
        self.assertEqual(order_keys_for_scope("pz"), ("ltl1", "ltl2", "ltl3"))
        self.assertEqual(ltl_keys_for_scope("pz"), ("ltl1", "ltl2", "ltl3"))
        self.assertEqual(dispatch_keys_for_scope("pz"), ("ltl_batch",))
        self.assertIn("ltl_consolidation", phase2_stages_for_scope("pz"))
        self.assertNotIn("ftl_loading_outbound", phase2_stages_for_scope("pz"))
        self.assertIn("batch_customs_release", phase3_stages_for_scope("pz"))
        self.assertNotIn("ftl_customs_release", phase3_stages_for_scope("pz"))

    def test_phase_modules_apply_and_restore_split_scope(self) -> None:
        self.addCleanup(phase2.configure_flow_scope, "combined")
        self.addCleanup(phase3.configure_flow_scope, "combined")
        self.addCleanup(phase4.configure_flow_scope, "combined")

        phase2.configure_flow_scope("ftl")
        phase3.configure_flow_scope("pz")
        phase4.configure_flow_scope("ftl")

        self.assertEqual(phase2.ORDER_KEYS, ("ftl",))
        self.assertEqual(phase2.LTL_KEYS, ())
        self.assertEqual(phase3.ORDER_KEYS, ("ltl1", "ltl2", "ltl3"))
        self.assertIn("batch_customs_release", phase3.PHASE3_STAGE_ORDER)
        self.assertNotIn("ftl_customs_release", phase3.PHASE3_STAGE_ORDER)
        self.assertEqual(phase4.ORDER_KEYS, ("ftl",))
        self.assertIn("ftl_customs_release", phase4.PHASE3_STAGE_ORDER)
        self.assertNotIn("batch_customs_release", phase4.PHASE3_STAGE_ORDER)

    def test_phase1_creates_only_the_orders_for_the_selected_demo(self) -> None:
        attempt = AttemptIdentity("demo", 1, "run", "DEMO", Path("output"))
        self.assertEqual(
            [item.key for item in phase1.phase1_records(attempt, "ftl")],
            ["ftl"],
        )
        self.assertEqual(
            [item.key for item in phase1.phase1_records(attempt, "pz")],
            ["ltl1", "ltl2", "ltl3"],
        )


if __name__ == "__main__":
    unittest.main()
