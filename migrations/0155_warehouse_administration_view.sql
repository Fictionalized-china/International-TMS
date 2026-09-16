PRAGMA foreign_keys = ON;

-- 管理端仓库菜单的可见权限与仓库配置写权限分离。
-- warehouse.view 继续仅代表仓库作业端登录/查看，不能用于管理端入口。
INSERT OR IGNORE INTO permissions(code,module,name,description)
VALUES(
  'warehouse.admin.view',
  'warehouse',
  '查看仓库管理',
  '查看管理端仓库清单与配置概况，不包含新增、编辑、停用或账号授权操作'
);

-- 既有仓库管理员继续拥有原来的管理端访问能力。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'warehouse.admin.view'
FROM role_permissions
WHERE permission_code='warehouse.manage';
