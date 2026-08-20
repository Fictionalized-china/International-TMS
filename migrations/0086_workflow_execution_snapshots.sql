PRAGMA foreign_keys = ON;

CREATE TABLE workflow_instance_step_states (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','completed','blocked')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(instance_id,step_key)
);

CREATE TABLE workflow_instance_module_states (
  id TEXT PRIMARY KEY,
  instance_step_state_id TEXT NOT NULL REFERENCES workflow_instance_step_states(id) ON DELETE CASCADE,
  step_module_id TEXT NOT NULL REFERENCES workflow_step_modules(id) ON DELETE RESTRICT,
  module_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_required INTEGER NOT NULL CHECK(is_required IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','completed','blocked')),
  responsibility_position_code TEXT,
  completion_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(instance_step_state_id,step_module_id)
);

CREATE TABLE workflow_instance_task_states (
  id TEXT PRIMARY KEY,
  instance_module_state_id TEXT NOT NULL REFERENCES workflow_instance_module_states(id) ON DELETE CASCADE,
  module_task_id TEXT NOT NULL REFERENCES workflow_module_tasks(id) ON DELETE RESTRICT,
  task_key TEXT NOT NULL,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_required INTEGER NOT NULL CHECK(is_required IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','completed','blocked')),
  responsibility_position_code TEXT,
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  instructions TEXT,
  completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(instance_module_state_id,module_task_id)
);

CREATE INDEX idx_workflow_instance_steps_current
  ON workflow_instance_step_states(instance_id,status,sort_order);
CREATE INDEX idx_workflow_instance_tasks_status
  ON workflow_instance_task_states(status,responsibility_position_code,assignee_user_id);

INSERT OR IGNORE INTO workflow_instance_step_states(
  id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,started_at,completed_at,updated_at
)
SELECT lower(hex(randomblob(16))),wi.id,wi.workflow_id,s.id,s.step_key,s.name,s.sort_order,
       CASE WHEN s.sort_order<(SELECT sort_order FROM workflow_steps x WHERE x.workflow_id=wi.workflow_id AND x.step_key=wi.current_step_key) THEN 'completed'
            WHEN s.step_key=wi.current_step_key THEN 'active' ELSE 'pending' END,
       CASE WHEN s.sort_order<=(SELECT sort_order FROM workflow_steps x WHERE x.workflow_id=wi.workflow_id AND x.step_key=wi.current_step_key) THEN wi.started_at ELSE NULL END,
       CASE WHEN s.sort_order<(SELECT sort_order FROM workflow_steps x WHERE x.workflow_id=wi.workflow_id AND x.step_key=wi.current_step_key) THEN wi.updated_at ELSE NULL END,
       datetime('now')
FROM workflow_instances wi JOIN workflow_steps s ON s.workflow_id=wi.workflow_id AND s.is_active=1;

INSERT OR IGNORE INTO workflow_instance_module_states(
  id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,status,
  responsibility_position_code,completion_mode,updated_at
)
SELECT lower(hex(randomblob(16))),ss.id,m.id,m.module_code,m.display_name,m.sort_order,m.is_required,
       CASE ss.status WHEN 'completed' THEN 'completed' WHEN 'active' THEN 'active' ELSE 'pending' END,
       m.responsibility_position_code,m.completion_mode,datetime('now')
FROM workflow_instance_step_states ss
JOIN workflow_step_modules m ON m.workflow_id=ss.workflow_id AND m.step_id=ss.step_id AND m.is_active=1;

INSERT OR IGNORE INTO workflow_instance_task_states(
  id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,is_required,status,
  responsibility_position_code,instructions,completed_at,updated_at
)
SELECT lower(hex(randomblob(16))),ms.id,t.id,t.task_key,t.name,t.task_type,t.sort_order,t.is_required,
       CASE ms.status WHEN 'completed' THEN 'completed' WHEN 'active' THEN 'active' ELSE 'pending' END,
       COALESCE(t.responsibility_position_code,ms.responsibility_position_code),t.instructions,
       CASE WHEN ms.status='completed' THEN datetime('now') ELSE NULL END,datetime('now')
FROM workflow_instance_module_states ms
JOIN workflow_module_tasks t ON t.workflow_id=(SELECT workflow_id FROM workflow_instance_step_states WHERE id=ms.instance_step_state_id)
 AND t.step_module_id=ms.step_module_id AND t.is_active=1;
