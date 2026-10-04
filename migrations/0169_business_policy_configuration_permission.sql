-- Forward-only companion for local installations that already applied 0168.
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('workflow.process_policy.manage','workflow','配置跨模块业务策略','指定配置人员维护录单、调度、运踪与签核规则；不授予其他审批权限');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'workflow.process_policy.manage' FROM roles WHERE code IN ('owner','boss','developer') AND status='active';
