export type ProductionAccountSite = "admin" | "warehouse" | "portal";

export type ProductionAccountBlueprint = {
  key: string;
  email: string;
  displayName: string;
  site: ProductionAccountSite;
  departmentCode: string | null;
  positionCode: string | null;
  roleCode: string | null;
  customerNumber?: 1 | 2 | 3;
  warehouseCode?: string;
  warehouseRole?: "domestic_collection" | "overseas_destination";
};

/**
 * Active login identities allowed in a freshly provisioned cloud environment.
 * Passwords are generated locally and are deliberately not stored here.
 */
export const productionAccountBlueprint: readonly ProductionAccountBlueprint[] = [
  { key: "boss", email: "admin@e2e.test", displayName: "老板账号", site: "admin", departmentCode: "ZJB", positionCode: "BOSS", roleCode: "owner" },
  { key: "developer", email: "developer@e2e.test", displayName: "开发者账号", site: "admin", departmentCode: "ZJB", positionCode: "DEVELOPER", roleCode: "developer" },
  { key: "sales", email: "sales@e2e.test", displayName: "业务岗账号", site: "admin", departmentCode: "SALER", positionCode: "SALES", roleCode: "pos_sales" },
  { key: "business-supervisor", email: "sales-supervisor@e2e.test", displayName: "业务主管账号", site: "admin", departmentCode: "SALER", positionCode: "BUSINESS_SUPERVISOR", roleCode: "pos_business_supervisor" },
  { key: "operation-supervisor", email: "operation-supervisor@e2e.test", displayName: "操作主管账号", site: "admin", departmentCode: "OP", positionCode: "OPERATION_SUPERVISOR", roleCode: "pos_operation_supervisor" },
  { key: "operation", email: "operation@e2e.test", displayName: "操作岗账号", site: "admin", departmentCode: "OP", positionCode: "OPERATION", roleCode: "pos_operation" },
  { key: "document", email: "doc@e2e.test", displayName: "单证岗账号", site: "admin", departmentCode: "OP", positionCode: "DOC", roleCode: "pos_doc" },
  { key: "customer-service", email: "cs@e2e.test", displayName: "客服岗账号", site: "admin", departmentCode: "OP", positionCode: "CS", roleCode: "pos_customer_service" },
  { key: "business-quote", email: "business-route@e2e.test", displayName: "商务报价岗账号", site: "admin", departmentCode: "BUS", positionCode: "BUSINESS_ROUTE", roleCode: "pos_business_route" },
  { key: "front-loading", email: "front-loading@e2e.test", displayName: "前端配载岗账号", site: "admin", departmentCode: "OP", positionCode: "LOADING", roleCode: "pos_front_loading" },
  { key: "finance", email: "finance@e2e.test", displayName: "财务会计岗账号", site: "admin", departmentCode: "ACC", positionCode: "FINANCE_ACCOUNTING", roleCode: "pos_finance" },
  { key: "cashier", email: "cashier@e2e.test", displayName: "出纳岗账号", site: "admin", departmentCode: "ACC", positionCode: "CASHIER", roleCode: "pos_cashier" },
  { key: "hr-admin", email: "hr-admin@e2e.test", displayName: "人事行政岗账号", site: "admin", departmentCode: "HR", positionCode: "HR_ADMIN", roleCode: "pos_hr_admin" },
  { key: "warehouse-domestic", email: "ucrstore01@e2e.test", displayName: "霍尔果斯普通仓账号", site: "warehouse", departmentCode: "OP", positionCode: "WAREHOUSE", roleCode: "warehouse_operator", warehouseCode: "HRG-01", warehouseRole: "domestic_collection" },
  { key: "warehouse-overseas", email: "overseas@e2e.test", displayName: "塔什干目的仓账号", site: "warehouse", departmentCode: "OP", positionCode: "OVERSEAS_WAREHOUSE", roleCode: "overseas_warehouse_operator", warehouseCode: "UZ-TAS-01", warehouseRole: "overseas_destination" },
  { key: "customer-1", email: "testclient1@e2e.test", displayName: "测试客户1", site: "portal", departmentCode: null, positionCode: null, roleCode: null, customerNumber: 1 },
  { key: "customer-2", email: "testclient2@e2e.test", displayName: "测试客户2", site: "portal", departmentCode: null, positionCode: null, roleCode: null, customerNumber: 2 },
  { key: "customer-3", email: "testclient3@e2e.test", displayName: "测试客户3", site: "portal", departmentCode: null, positionCode: null, roleCode: null, customerNumber: 3 },
] as const;

export const productionAccountEmails = productionAccountBlueprint.map((account) => account.email);
