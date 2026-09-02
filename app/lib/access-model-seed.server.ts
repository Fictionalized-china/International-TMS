type PositionSeed = [code: string, name: string, departmentCode: string, sortOrder: number];
type RoleSeed = [code: string, name: string, description: string];

const departments = [
  ["SALER", "业务部", 10],
  ["BUS", "商务部", 20],
  ["OP", "操作部", 30],
  ["ACC", "财务部", 40],
  ["HR", "人事行政部", 50],
  ["ZJB", "总经办", 60],
] as const;

const positions: PositionSeed[] = [
  ["BOSS", "老板", "ZJB", 1],
  ["DEVELOPER", "开发者", "ZJB", 2],
  ["SALES", "业务岗", "SALER", 10],
  ["OPERATION", "单证（操作岗）", "OP", 20],
  ["TRACKING", "运踪岗", "OP", 30],
  ["CS", "客服岗", "OP", 40],
  ["BUSINESS_ROUTE", "商务报价岗", "BUS", 50],
  ["LOADING", "前端配载岗", "OP", 60],
  ["FINANCE_ACCOUNTING", "财务会计岗", "ACC", 70],
  ["CASHIER", "出纳岗", "ACC", 80],
  ["HR_ADMIN", "人事行政岗", "HR", 90],
  ["WAREHOUSE", "仓库岗", "OP", 110],
  ["OVERSEAS_WAREHOUSE", "境外仓库岗", "OP", 120],
];

const roles: RoleSeed[] = [
  ["boss", "老板", "拥有全部权限且不可抽走"],
  ["developer", "开发者", "维护工作流、字段积木和系统配置"],
  ["pos_sales", "业务岗", "开发本人客户、创建报价、查看本人订单全程"],
  ["pos_operation", "单证（操作岗）", "从上门提货到妥投签收的订单执行"],
  ["pos_tracking", "运踪岗", "车辆资料与每日运踪更新"],
  ["pos_customer_service", "客服岗", "订单资料、费用、账单、对账与收款协同"],
  ["pos_business_route", "商务报价岗", "仅用于岗位与薪资归类，默认不授予权限"],
  ["pos_front_loading", "前端配载岗", "仅用于岗位与薪资归类，默认不授予权限"],
  ["pos_finance", "财务会计岗", "财务查询、费用审批、利润统计和导出"],
  ["pos_cashier", "出纳岗", "收付款登记与核销"],
  ["pos_hr_admin", "人事行政岗", "账号、组织、岗位和权限维护"],
  ["warehouse_operator", "仓库作业账号", "国内仓收货、装车、出库与异常处理"],
  ["overseas_warehouse_operator", "境外仓库作业账号", "境外仓到仓、通知与提货"],
];

const rolePermissions: Record<string, string[]> = {
  developer: ["dashboard.view", "workflow.view", "workflow.manage", "workflow.field.manage", "master.view", "user.view", "role.view", "audit.view", "order.view", "order.scope.all"],
  pos_sales: ["dashboard.view", "customer.view", "customer.manage", "customer.scope.own", "customer.sensitive.view", "sales.view", "sales.manage", "quote.view", "quote.manage", "order.view", "order.scope.assigned", "order.scope.sales_own"],
  pos_operation: ["dashboard.view", "order.view", "order.manage", "order.scope.assigned", "shipment.view", "shipment.manage", "carrier.view", "order.module.assignment.manage", "order.module.transport.manage", "order.module.warehouse.manage", "order.module.loading.manage", "order.module.documents.manage", "order.module.customs.manage", "order.module.overseas_warehouse.manage", "order.module.exceptions.manage", "order.module.review.manage"],
  pos_tracking: ["dashboard.view", "order.view", "order.scope.assigned", "shipment.view", "shipment.manage", "order.module.tracking.manage"],
  pos_customer_service: ["dashboard.view", "customer.view", "customer.scope.all", "customer.sensitive.view", "order.view", "order.manage", "order.scope.assigned", "billing.view", "billing.manage", "billing.sensitive.view", "billing.cash.manage", "order.module.consignment.manage", "order.module.cargo.manage", "order.module.costs.manage"],
  pos_finance: ["dashboard.view", "order.view", "order.manage", "order.scope.all", "billing.view", "billing.manage", "billing.sensitive.view", "billing.expense.approve", "analytics.business.view", "analytics.profit.view", "data.export", "audit.view", "order.module.costs.manage", "order.module.review.manage"],
  pos_cashier: ["dashboard.view", "order.view", "order.scope.all", "billing.view", "billing.sensitive.view", "billing.cash.manage", "data.export"],
  pos_hr_admin: ["dashboard.view", "organization.view", "user.view", "user.manage", "role.view", "role.manage", "department.view", "department.manage", "security.manage", "audit.view"],
  warehouse_operator: ["dashboard.view", "order.view", "order.scope.assigned", "warehouse.view", "warehouse.operate", "order.module.warehouse.manage", "order.module.loading.manage", "order.module.exceptions.manage"],
  overseas_warehouse_operator: ["dashboard.view", "order.view", "order.scope.assigned", "warehouse.view", "warehouse.operate", "order.module.overseas_warehouse.manage", "order.module.exceptions.manage"],
};

export function accessModelBootstrapStatements(
  db: D1Database,
  organizationId: string,
  ownerUserId: string,
  now: string,
) {
  const statements: D1PreparedStatement[] = [];
  for (const [code, name, sortOrder] of departments) {
    statements.push(db.prepare(
      `INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?,?)`,
    ).bind(`${organizationId}:department:${code}`, organizationId, null, code, name, sortOrder, now, now));
  }
  for (const [code, name, departmentCode, sortOrder] of positions) {
    statements.push(db.prepare(
      `INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?,?)`,
    ).bind(`${organizationId}:position:${code}`, organizationId, code, name, departmentCode, sortOrder, now, now));
  }
  for (const [code, name, description] of roles) {
    const roleId = `${organizationId}:role:${code}`;
    statements.push(db.prepare(
      `INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
       VALUES(?,?,?,?,?,1,'active',?,?)`,
    ).bind(roleId, organizationId, code, name, description, now, now));
    if (code === "boss") {
      statements.push(db.prepare(
        "INSERT INTO role_permissions(role_id,permission_code) SELECT ?,code FROM permissions",
      ).bind(roleId));
      continue;
    }
    const permissions = rolePermissions[code] ?? [];
    if (permissions.length) {
      statements.push(db.prepare(
        `INSERT INTO role_permissions(role_id,permission_code)
         SELECT ?,code FROM permissions WHERE code IN (${permissions.map(() => "?").join(",")})`,
      ).bind(roleId, ...permissions));
    }
  }
  for (const [code] of positions) {
    statements.push(db.prepare(
      `INSERT INTO position_portal_settings(
        id,organization_id,position_id,order_scope,default_filter,created_at,updated_at
       ) VALUES(?,?,?,?, 'open',?,?)`,
    ).bind(
      `${organizationId}:portal:${code}`,
      organizationId,
      `${organizationId}:position:${code}`,
      "current_position",
      now,
      now,
    ));
  }
  statements.push(db.prepare(
    `UPDATE memberships SET
       department_id=?,position_id=?,title='老板',updated_at=?
     WHERE organization_id=? AND user_id=?`,
  ).bind(
    `${organizationId}:department:ZJB`,
    `${organizationId}:position:BOSS`,
    now,
    organizationId,
    ownerUserId,
  ));
  return statements;
}
