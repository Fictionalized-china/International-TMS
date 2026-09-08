PRAGMA foreign_keys = ON;

-- Account eligibility overrides for a configured workflow node.  The
-- workflow remains the source of the responsible position; these rows only
-- qualify or disqualify individual accounts inside that responsibility pool.
CREATE TABLE membership_workflow_access_overrides (
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  module_code TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(membership_id,step_key,module_code)
);

CREATE INDEX idx_membership_workflow_access_effective
  ON membership_workflow_access_overrides(
    membership_id,effect,step_key,module_code
  );
