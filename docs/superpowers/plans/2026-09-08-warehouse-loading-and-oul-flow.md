# 国内仓最终包装与装车出库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将整车和 PZ 的最终包装、OUL 生成打印、连续扫码和整批出库收敛为四阶段单页工作台，同时原样保留现有文件上传与跨账号审核门禁。

**Architecture:** 新增订单级 `warehouse_packing_batches`，把一张订单的入仓唛头集合与最终 OUL 集合关联到同一包装批次，不再虚构逐个入仓唛头到单张 OUL 的映射。`warehouse.outbound` 继续负责冻结工作流和文件门禁校验，包装计划下沉到纯函数，创建包装批次、OUL、装车任务和明细仍在一个 D1 `batch()` 原子提交内完成。主页面按数据库状态派生当前阶段，文件和打印标签使用右侧抽屉，不以临时 React 状态代替业务状态。

**Tech Stack:** React 19、React Router 8、TypeScript 5.9、Cloudflare Workers/D1、Vitest、Python sqlite3 migration tests、现有 `app/app.css` 设计系统。

---

## 文件结构

- Create: `migrations/0140_warehouse_packing_batches.sql` — 最终包装批次、来源关联、打印/贴标状态和跨订单数据库约束。
- Create: `tests/migrations/test_0140_warehouse_packing_batches.py` — 验证包装批次表、来源归属、OUL 订单归属和状态约束。
- Create: `app/lib/warehouse-packing-plan.ts` — 解析并验证每张订单的最终包装输入，生成不含虚构逐包关系的 OUL 计划。
- Create: `app/lib/warehouse-packing-plan.test.ts` — 整车、PZ、保持原包装、合包、拆包和非法跨订单输入的纯函数测试。
- Modify: `app/routes/warehouse.outbound.tsx` — 创建事务、阶段派生、文件摘要抽屉、包装表单、打印抽屉、贴标确认和扫码主工作台。
- Modify: `app/routes/warehouse.outbound.interaction.test.ts` — 文件门禁不回归、阶段 UI、只读视图、抽屉、连续扫码和 PZ 分组进度测试。
- Modify: `app/lib/warehouse-outbound-dispatch.server.ts` — 出库完成时原子推进包装批次并锁定 OUL 生命周期。
- Modify: `app/lib/warehouse-outbound-dispatch.server.test.ts` — 验证包装批次和 OUL 与装车任务一起原子完成。
- Modify: `app/routes/warehouse.inbound.tsx` — 境外收货继续按 OUL 扫描，但订单级重量体积从包装批次读取，避免平均拆分伪数据。
- Modify: `app/routes/warehouse.inbound-gate.test.ts` — 境外仓整批 OUL 门禁和包装批次总量回归。
- Modify: `app/routes/warehouse.pickup.tsx` — 自提列表不再把 OUL 的技术 `pieces=1` 表述为商品件数。
- Modify: `app/routes/warehouse.pickup-gate.test.ts` — 客户自提继续扫描同一 OUL 且不依赖单包重量。
- Modify: `app/app.css` — 四阶段单页工作台、紧凑门禁摘要、右侧抽屉、OUL 打印和扫码布局。
- Modify: `app/routes/warehouse.index.tsx` — 修正 OUL 生成时点的旧提示文字。

## Task 1：建立最终包装批次数据库边界

**Files:**
- Create: `migrations/0140_warehouse_packing_batches.sql`
- Create: `tests/migrations/test_0140_warehouse_packing_batches.py`

- [ ] **Step 1: 先写迁移失败测试**

在测试中建立最小 `organizations`、`users`、`warehouses`、`transport_orders`、`transport_batches`、`shipments`、`warehouse_packages` 和 `warehouse_dispatches` 表，执行迁移后断言：

```python
def test_rejects_cross_order_source_and_oul(self):
    self.add_order("order-a", "shipment-a")
    self.add_order("order-b", "shipment-b")
    self.add_batch("packing-a", "order-a", "dispatch-1")
    self.add_package("inbound-b", "shipment-b", "inbound_mark")
    with self.assertRaises(sqlite3.IntegrityError):
        self.db.execute(
            "INSERT INTO warehouse_packing_batch_sources VALUES(?,?,?,?,?)",
            ("source-1", "org-1", "packing-a", "inbound-b", "2026-09-08T00:00:00Z"),
        )

    with self.assertRaises(sqlite3.IntegrityError):
        self.db.execute(
            "INSERT INTO warehouse_packages(id,organization_id,shipment_id,label_kind,packing_batch_id) "
            "VALUES('oul-b','org-1','shipment-b','oul','packing-a')"
        )
```

另写成功用例，验证同订单多个入仓唛头可以共同关联到一个包装批次，且该批次可以生成任意合法数量的同订单 OUL。

- [ ] **Step 2: 运行迁移测试并确认失败**

Run: `python tests/migrations/test_0140_warehouse_packing_batches.py`  
Expected: FAIL，提示 `0140_warehouse_packing_batches.sql` 不存在。

- [ ] **Step 3: 编写迁移**

迁移必须包含以下结构和约束：

```sql
CREATE TABLE warehouse_packing_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  transport_batch_id TEXT REFERENCES transport_batches(id) ON DELETE RESTRICT,
  dispatch_id TEXT NOT NULL REFERENCES warehouse_dispatches(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK(source_type IN ('ftl_order','pz_order')),
  packing_mode TEXT NOT NULL CHECK(packing_mode IN ('preserve','merge','split')),
  source_package_count INTEGER NOT NULL CHECK(source_package_count > 0),
  outbound_package_count INTEGER NOT NULL CHECK(outbound_package_count BETWEEN 1 AND 500),
  total_weight_kg REAL CHECK(total_weight_kg IS NULL OR total_weight_kg > 0),
  total_volume_cbm REAL CHECK(total_volume_cbm IS NULL OR total_volume_cbm > 0),
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK(status IN ('generated','printed','labelled','loading','dispatched','cancelled')),
  labels_printed_at TEXT,
  labels_printed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  labeling_confirmed_at TEXT,
  labeling_confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,dispatch_id,order_id,revision),
  CHECK(
    (source_type='ftl_order' AND transport_batch_id IS NULL) OR
    (source_type='pz_order' AND transport_batch_id IS NOT NULL)
  )
);

CREATE TABLE warehouse_packing_batch_sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  packing_batch_id TEXT NOT NULL REFERENCES warehouse_packing_batches(id) ON DELETE CASCADE,
  inbound_warehouse_package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(packing_batch_id,inbound_warehouse_package_id)
);

ALTER TABLE warehouse_packages ADD COLUMN packing_batch_id TEXT
  REFERENCES warehouse_packing_batches(id) ON DELETE RESTRICT;
```

增加 `BEFORE INSERT` 和 `BEFORE UPDATE` 触发器：来源包必须为同组织、同仓库、`label_kind='inbound_mark'` 且其 `shipment.order_id` 等于包装批次 `order_id`；带 `packing_batch_id` 的 OUL 必须为同组织、同仓库、`label_kind='oul'` 且其 `shipment.order_id` 等于包装批次 `order_id`。整车包装批次的装车任务主运单必须属于该订单；PZ 包装批次的订单必须仍是对应 `transport_batch_id` 的有效挂载订单，且配载单属于同组织和同仓库。包装批次一旦关联来源包或 OUL 后，禁止修改 `organization_id`、`warehouse_id`、`order_id`、`dispatch_id`、`transport_batch_id` 和 `source_type`，避免通过更新绕开归属约束。

- [ ] **Step 4: 运行迁移测试并确认通过**

Run: `python tests/migrations/test_0140_warehouse_packing_batches.py`  
Expected: `OK`，同订单成功、跨订单来源和跨订单 OUL 均被 SQLite 约束拒绝。

- [ ] **Step 5: 提交数据库批次**

```powershell
git add migrations/0140_warehouse_packing_batches.sql tests/migrations/test_0140_warehouse_packing_batches.py
git commit -m "feat: add warehouse packing batch boundary"
```

## Task 2：建立不虚构逐包映射的包装计划

**Files:**
- Create: `app/lib/warehouse-packing-plan.ts`
- Create: `app/lib/warehouse-packing-plan.test.ts`
- Modify: `app/lib/package-identity.ts`
- Modify: `app/lib/package-identity.test.ts`

- [ ] **Step 1: 写包装计划失败测试**

覆盖：保持原包装自动使用来源数、10 合 6、2 拆 3、PZ 三订单分别生成 6/4/3 张、空来源、数量越界和请求中出现未知订单。

```ts
it("creates order-owned outputs without invented source-to-output mapping", () => {
  const result = buildWarehousePackingPlan({
    requests: [{ orderId: "order-a", orderNumber: "SO-A", sourceType: "ftl_order", transportBatchId: null, mode: "merge", outboundPackageCount: 6, totalWeightKg: 120, totalVolumeCbm: 0.6, notes: "" }],
    sources: Array.from({ length: 10 }, (_, index) => source("order-a", index + 1)),
    createId: sequenceId(),
    createOulCode: ({ orderNumber, sequence, total }) => `${orderNumber}-OUL-${sequence}-${total}`,
  });

  expect(result.batches[0]).toMatchObject({ sourcePackageIds: expect.arrayContaining(["source-1", "source-10"]), outboundPackageCount: 6 });
  expect(result.batches[0].outputs).toHaveLength(6);
  expect(result.batches[0].outputs.every(item => item.orderId === "order-a")).toBe(true);
  expect(result.batches[0].outputs.some(item => "sourcePackageIds" in item)).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run app/lib/warehouse-packing-plan.test.ts app/lib/package-identity.test.ts`  
Expected: FAIL，`buildWarehousePackingPlan` 和 `oulCode` 尚未定义。

- [ ] **Step 3: 实现纯函数和 OUL 编号**

核心类型必须固定为：

```ts
export type PackingMode = "preserve" | "merge" | "split";

export type PackingOrderRequest = {
  orderId: string;
  orderNumber: string;
  sourceType: "ftl_order" | "pz_order";
  transportBatchId: string | null;
  mode: PackingMode;
  outboundPackageCount: number;
  totalWeightKg: number | null;
  totalVolumeCbm: number | null;
  notes: string;
};

export type PlannedPackingBatch = {
  id: string;
  orderId: string;
  orderNumber: string;
  sourceType: "ftl_order" | "pz_order";
  transportBatchId: string | null;
  mode: PackingMode;
  sourcePackageIds: string[];
  outboundPackageCount: number;
  totalWeightKg: number | null;
  totalVolumeCbm: number | null;
  notes: string;
  outputs: Array<{
    id: string;
    code: string;
    orderId: string;
    shipmentId: string;
    receiptId: string;
    locationId: string;
  }>;
};
```

`buildWarehousePackingPlan` 对每个请求只使用相同 `orderId` 的来源包；整车请求必须是 `sourceType='ftl_order'` 且 `transportBatchId=null`，PZ 请求必须是 `sourceType='pz_order'` 且携带同一有效 `transportBatchId`。OUL 输出不携带 `sourcePackageIds`，重量体积只保存在批次上，不平均拆分到单张 OUL。

在 `package-identity.ts` 增加：

```ts
export function oulCode(orderNumber: string, sequence: number, total: number, suffix: string) {
  assertPackageCount(sequence, "OUL 序号");
  assertPackageCount(total, "OUL 总数");
  if (sequence > total) throw new Error("OUL 序号不能大于总数");
  if (!/^[2-9A-HJ-NP-Z]{4}$/.test(suffix)) throw new Error("OUL 随机码无效");
  const orderPart = orderNumber.replace(/[^A-Z0-9]/gi, "").slice(-12).toUpperCase();
  return `OUL-${orderPart}-${String(sequence).padStart(3, "0")}-${String(total).padStart(3, "0")}-${suffix}`;
}
```

- [ ] **Step 4: 运行纯函数测试并确认通过**

Run: `npx vitest run app/lib/warehouse-packing-plan.test.ts app/lib/package-identity.test.ts`  
Expected: PASS，且测试明确断言不存在逐包来源映射和均分重量体积。

- [ ] **Step 5: 提交包装计划批次**

```powershell
git add app/lib/warehouse-packing-plan.ts app/lib/warehouse-packing-plan.test.ts app/lib/package-identity.ts app/lib/package-identity.test.ts
git commit -m "feat: model order level outbound packing"
```

## Task 3：修正文件自审边界并原子创建任务、包装批次和 OUL

**Files:**
- Modify: `app/routes/warehouse.outbound.tsx`
- Modify: `app/routes/warehouse.outbound.interaction.test.ts`

- [ ] **Step 1: 写创建边界失败测试**

导出并测试 `parsePackingRequests` 和 `packingCreationStatements`。测试必须断言：

```ts
expect(plan.batches).toHaveLength(3);
expect(plan.batches.map(batch => batch.orderId)).toEqual(["order-a", "order-b", "order-c"]);
expect(allSql).toContain("INSERT INTO warehouse_packing_batches");
expect(allSql).toContain("INSERT INTO warehouse_packing_batch_sources");
expect(allSql).toContain("packing_batch_id");
expect(allSql).not.toContain("INSERT INTO warehouse_package_relations");
expect(allSql).not.toContain("splitPackingMeasure");
```

再渲染文件门禁摘要并覆盖四个动作测试：普通仓库账号上传后直接为 `approved` 且 `reviewed_by_user_id=NULL`；老板/开发者上传后仍可人工审核；其他账号上传的 `pending` 文件不会被创建任务动作自动通过；`rejected` 文件仍阻断并要求重新上传。

- [ ] **Step 2: 运行路由测试并确认失败**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts`  
Expected: FAIL，包装批次语句和文件门禁摘要尚不存在。

- [ ] **Step 3: 替换创建事务中的旧包装映射**

在 `intent === "create"` 的所有现有工作流、权限、入仓、PZ、文件和运输资源校验完成后：

```ts
const packingRequests = parsePackingRequests(form, inspection.documentGroups, inspection.packingSources);
const packingPlan = buildWarehousePackingPlan({
  requests: packingRequests,
  sources: inspection.packingSources,
  createId: () => crypto.randomUUID(),
  createOulCode: ({ orderNumber, sequence, total }) =>
    oulCode(orderNumber, sequence, total, randomOulSuffix()),
});
```

数据库 `batch()` 的顺序固定为：新司机（如有）、`warehouse_dispatches`、每张订单的 `warehouse_packing_batches`、全部来源关联、全部 OUL、全部 `warehouse_dispatch_items`、入仓唛头终止流转、运输资源、PZ 状态和审计所需业务状态。

单张 OUL 保存：

```sql
INSERT INTO warehouse_packages(
  id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,
  barcode,package_number,pieces,weight_kg,volume_cbm,status,notes,
  created_at,updated_at,cargo_item_id,label_kind,lifecycle_status,
  source_order_package_id,packing_revision,packing_batch_id
) VALUES(?,?,?,?,?,?,?,?,1,NULL,NULL,'allocated',?,?,?,NULL,'oul','active',NULL,1,?)
```

删除旧 `warehouse_package_relations` 写入、来源轮询分组和 `splitPackingMeasure`。来源入仓唛头只与包装批次关联。

- [ ] **Step 4: 复用统一文件自审规则，保留跨账号审核**

`loading_document_upload` 继续写入现有 `order_attachments` 和 `order_document_metadata`，并原样保留 `loadOrderDocumentWorkflowMutationAccess` 校验。复用 `hasOrderDocumentSystemOverride` 与 `isOrderDocumentSelfReviewBlocked`：

- 普通岗位在本路由上传时直接写入 `review_status='approved'`、`reviewed_by_user_id=NULL`、`reviewed_at=now`，与订单模块现有“上传即确认”规则一致。
- 老板、开发者上传时保留 `pending`，允许其按系统覆盖权限人工审核。
- `loading_documents_approve` 只处理当前账号有权复核且不是自己上传的待审文件；系统覆盖账号不受自审限制。
- `create` 不得更新任何文件审核状态，只重新读取并校验文件门禁。

`create` 提交固定执行：

```ts
const missing = inspection.documents.filter(document => document.required && !document.attachmentId);
if (missing.length) return rejectCreate(formatMissingDocuments(missing));

const incomplete = inspection.documents.filter(document =>
  document.required && !["approved", "archived"].includes(document.reviewStatus ?? "")
);
if (incomplete.length) return rejectCreate(formatIncompleteDocuments(incomplete));
```

`formatIncompleteDocuments` 必须区分“待其他账号审核”和“已退回需重新上传”，不能把 `pending`、`rejected` 或选填文件混成同一提示。删除当前 `create` 分支中的 `documentsToApprove` 更新语句及 `warehouse.outbound.documents_confirm_and_create` 审计动作，避免创建装车任务越权改变跨账号审核结果。

- [ ] **Step 5: 运行路由测试并确认通过**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts app/lib/warehouse-packing-plan.test.ts`  
Expected: PASS，创建语句无虚构逐包映射，文件门禁测试保持通过。

- [ ] **Step 6: 提交原子创建批次**

```powershell
git add app/routes/warehouse.outbound.tsx app/routes/warehouse.outbound.interaction.test.ts
git commit -m "feat: create loading tasks from packing batches"
```

## Task 4：实现四阶段单页工作台与两个右侧抽屉

**Files:**
- Modify: `app/routes/warehouse.outbound.tsx`
- Modify: `app/routes/warehouse.outbound.interaction.test.ts`
- Modify: `app/app.css`
- Modify: `app/routes/warehouse.index.tsx`

- [ ] **Step 1: 写阶段与抽屉渲染失败测试**

测试 `CreateDispatchWorkbench` 和任务详情，断言：

```ts
expect(markup).toContain("确认最终包装");
expect(markup).toContain("创建装车任务");
expect(markup).toContain("打印并贴 OUL");
expect(markup).toContain("扫码装车出库");
expect(markup).toContain("装车资料 3/3 已齐套");
expect(markup).not.toContain("oul-label-print-area");
expect(markup).not.toContain("warehouse_package_relations");
```

PZ 测试必须渲染三张订单行、各自的最终包裹数输入，并断言运输资源为只读摘要；整车测试必须渲染工作流启用的承运商、车辆、司机、路线和时间字段。

- [ ] **Step 2: 运行交互测试并确认失败**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts`  
Expected: FAIL，仍显示完整文件工作区和内联 OUL 标签。

- [ ] **Step 3: 实现顶部摘要和四阶段导航**

新增数据库派生的最大可达阶段；创建任务前的“确认最终包装 / 创建装车任务”只是同一份未提交草稿的两个 UI 步骤，不伪装成已保存业务状态：

```ts
type PersistedOutboundStage = "preparation" | "labels" | "loading" | "completed";

function persistedOutboundStage(input: {
  dispatchStatus: string | null;
  packingBatchCount: number;
  unlabelledBatchCount: number;
  loadedCount: number;
  itemCount: number;
}): PersistedOutboundStage {
  if (input.dispatchStatus === "dispatched") return "completed";
  if (!input.dispatchStatus) return "preparation";
  if (input.unlabelledBatchCount > 0) return "labels";
  return "loading";
}
```

`preparation` 内使用 `"packing" | "task"` 客户端步骤组织同一份草稿；从第一步进入第二步只校验当前可见输入，不写数据库。服务端校验失败时返回第二步并保留草稿；刷新后未提交草稿回到第一步，已经创建任务的页面则使用 loader 返回的包装批次状态恢复到标签或扫码阶段。阶段切换仅负责折叠和回看，能否提交完全由服务器状态决定。

- [ ] **Step 4: 将文件工作区改为摘要加右侧抽屉**

复用 `useModalScrollLock` 和现有 `linear-drawer-backdrop`/`linear-order-drawer` 样式结构。摘要接口固定为：

```tsx
<OutboundDocumentGateSummary
  groups={inspection.documentGroups}
  open={documentDrawerOpen}
  onOpen={() => setDocumentDrawerOpen(true)}
/>
```

上传仍使用独立 `<Form method="post" encType="multipart/form-data">`，包装字段保存在当前 React 草稿状态；上传响应不得重建整个创建表单的 `key`，不得清空 `packingDrafts`。

- [ ] **Step 5: 将 OUL 改为摘要加打印抽屉**

主工作区只显示包装批次和标签数量。点击“打印 OUL”打开右侧抽屉，抽屉内部才挂载 `.oul-label-print-area`。打印按钮通过 `useFetcher` 先提交 `intent=record_oul_print`，服务器把所有当前任务包装批次改为 `printed` 并记录操作人；成功后调用 `window.print()`。

点击“已完成贴标，开始装车”提交 `intent=confirm_oul_labeling`，服务器确认每个包装批次已有打印记录后原子写入 `labeling_confirmed_at` 和 `status='labelled'`。

- [ ] **Step 6: 完成页面样式和旧提示修正**

CSS 要求：

```css
.outbound-stage-strip { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
.outbound-stage-panel { padding:16px; }
.outbound-packing-order-grid { display:grid; grid-template-columns:minmax(220px,1.4fr) repeat(4,minmax(120px,.7fr)); align-items:end; }
.outbound-side-drawer { width:min(760px,92vw); height:100vh; overflow:auto; }
.outbound-label-summary { display:flex; align-items:center; justify-content:space-between; min-height:54px; }
.outbound-stage-panel textarea { min-height:calc(var(--control-height) * 3); }
```

主页面使用整页滚动，不设置内部纵向滚动。修正 `warehouse.index.tsx` 中“国内仓收货时生成 OUL”的旧提示为“创建装车任务时按最终出仓包裹数生成 OUL”。

- [ ] **Step 7: 运行 UI 测试并提交**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts app/peer-page-tabs-contract.test.ts`  
Expected: PASS；主页面不内联标签，文件和打印抽屉可被无障碍角色识别。

```powershell
git add app/routes/warehouse.outbound.tsx app/routes/warehouse.outbound.interaction.test.ts app/app.css app/routes/warehouse.index.tsx
git commit -m "feat: stage warehouse loading workbench"
```

## Task 5：锁定贴标、连续扫码和整批出库门禁

**Files:**
- Modify: `app/routes/warehouse.outbound.tsx`
- Modify: `app/routes/warehouse.outbound.interaction.test.ts`
- Modify: `app/lib/warehouse-outbound-dispatch.server.ts`
- Modify: `app/lib/warehouse-outbound-dispatch.server.test.ts`

- [ ] **Step 1: 写贴标与出库失败测试**

增加以下断言：

```ts
expect(validateLoadingScan({ labelingConfirmed: false, barcode: "OUL-A" }))
  .toBe("请先完成 OUL 打印贴标，再开始装车扫码");
expect(validateLoadingScan({ labelingConfirmed: true, barcode: "OUL-A" })).toBeNull();
expect(progressByOrder(items)).toEqual([
  { orderNumber: "SO-A", loaded: 6, total: 6 },
  { orderNumber: "SO-B", loaded: 3, total: 4 },
]);
```

服务端测试断言完成出库的同一 `batch()` 同时更新装车明细、OUL 生命周期、包装批次 `status='dispatched'` 和装车任务 CAS；CAS 失败时调用方不得重复写后置业务进度。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts app/lib/warehouse-outbound-dispatch.server.test.ts`  
Expected: FAIL，贴标门禁和包装批次出库更新尚未实现。

- [ ] **Step 3: 实现连续扫码行为**

扫码表单保留 `intent=load`，但输入框回车自动提交，不显示“确认装车”按钮：

```tsx
<fetcher.Form method="post" onSubmit={() => setLastScan(code)}>
  <input type="hidden" name="intent" value="load" />
  <input type="hidden" name="dispatchId" value={task.id} />
  <OutboundBarcodeInput busy={fetcher.state !== "idle"} autoFocus />
</fetcher.Form>
```

每次响应后清空输入、恢复焦点并更新 `已扫/应扫`。重复、跨任务、作废和跨仓库条码只通过右上角提示反馈，不清空既有正确进度。
首张有效 OUL 成功登记时，在同一 `batch()` 中把该 OUL 所属包装批次从 `labelled` 更新为 `loading`；重复扫描不得重复推进或修改批次。

- [ ] **Step 4: 实现整车和 PZ 进度摘要**

整车显示总进度；PZ 额外显示每张订单的 `loaded/total`。主表只显示 10 行并分页，扫码状态更新不改变当前页和筛选。

只有全部有效 OUL 扫齐后显示：整车“确认整车出库”、PZ“确认配载出库”。删除正常流程中的少扫差异确认入口，异常出库只能进入异常模块。

- [ ] **Step 5: 重做整张订单包装批次，不再恢复逐包映射**

保留 `intent=repack_oul`，但将其改为包装批次版本重做：只要当前任务任意 OUL 已扫描或任务已出库，服务端立即拒绝；未扫描时按订单读取当前有效包装批次及 `warehouse_packing_batch_sources`，重新使用 `parsePackingRequests` 和 `buildWarehousePackingPlan` 生成下一版本。

同一 D1 `batch()` 必须按顺序完成：旧批次 `status='cancelled'`、旧 OUL `lifecycle_status='voided'`、删除旧装车明细、创建新版本包装批次、复制该订单原来源关联、创建新 OUL 和新装车明细。重做后打印与贴标状态清零，页面回到“打印并贴 OUL”；不得读取或写入 `warehouse_package_relations`，不得恢复来源轮询或平均拆分重量体积。

- [ ] **Step 6: 原子推进包装批次和 OUL**

在 `completeWarehouseDispatchTransaction` 的现有 D1 `batch()` 中加入：

```sql
UPDATE warehouse_packing_batches
SET status='dispatched',updated_at=?
WHERE organization_id=? AND warehouse_id=? AND dispatch_id=?
  AND status IN ('labelled','loading');
```

出库前查询必须确认：任务至少一张 OUL、全部明细 `loaded`、全部包装批次 `labeling_confirmed_at IS NOT NULL`。成功后 OUL 统一进入 `lifecycle_status='in_transit'`；首张 OUL 扫描后，调整包装数量入口永久隐藏且服务端拒绝 `repack_oul`。

- [ ] **Step 7: 运行测试并提交**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts app/lib/warehouse-outbound-dispatch.server.test.ts`  
Expected: PASS，贴标前不能扫码、未扫齐不能出库、PZ 逐订单进度正确，重做包装不会恢复虚构逐包映射。

```powershell
git add app/routes/warehouse.outbound.tsx app/routes/warehouse.outbound.interaction.test.ts app/lib/warehouse-outbound-dispatch.server.ts app/lib/warehouse-outbound-dispatch.server.test.ts
git commit -m "feat: gate atomic OUL loading and dispatch"
```

## Task 6：保持境外仓与客户自提使用同一 OUL

**Files:**
- Modify: `app/routes/warehouse.inbound.tsx`
- Modify: `app/routes/warehouse.inbound-gate.test.ts`
- Modify: `app/routes/warehouse.pickup.tsx`
- Modify: `app/routes/warehouse.pickup-gate.test.ts`

- [ ] **Step 1: 写下游回归失败测试**

境外仓测试构造 6 张 OUL 属于同一包装批次，断言扫描任意一张调出整张装车任务，必须 6/6 才能一次入仓；订单总重量体积只从包装批次累计一次。

自提测试断言同一 6 张 OUL 必须全部扫描后才能签收，列表标题为“出仓包裹”而不是“商品件数”。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run app/routes/warehouse.inbound-gate.test.ts app/routes/warehouse.pickup-gate.test.ts`  
Expected: FAIL，现有显示仍读取单张 OUL 技术重量或 `pieces`。

- [ ] **Step 3: 调整境外仓汇总口径**

扫描范围仍严格使用装车任务中的有效 `label_kind='oul'`。重量体积汇总改为：

```sql
SELECT pb.order_id,
       COUNT(p.id) outbound_packages,
       pb.total_weight_kg,
       pb.total_volume_cbm
FROM warehouse_packing_batches pb
JOIN warehouse_packages p
  ON p.packing_batch_id=pb.id
 AND p.organization_id=pb.organization_id
WHERE pb.organization_id=? AND pb.dispatch_id=? AND pb.status='dispatched'
GROUP BY pb.id,pb.order_id,pb.total_weight_kg,pb.total_volume_cbm;
```

写境外收货汇总时按包装批次求和一次，不按 OUL 数量重复累计。单张 OUL 的重量体积显示为“按包装批次登记”，不显示平均值。

- [ ] **Step 4: 调整客户自提文案但不改变门禁**

保留现有 `scannedOulCodes` 整单校验和 `lifecycle_status='overseas_received'` 条件。表格列改为“出仓包裹序号”“包装批次实测”，移除 `item.pieces` 的商品件数暗示。

- [ ] **Step 5: 运行下游测试并提交**

Run: `npx vitest run app/routes/warehouse.inbound-gate.test.ts app/routes/warehouse.pickup-gate.test.ts app/lib/overseas-inbound-policy.test.ts app/lib/warehouse-pickup-workflow-policy.test.ts`  
Expected: PASS，境外仓和客户自提继续扫描同一 OUL，汇总不重复重量体积。

```powershell
git add app/routes/warehouse.inbound.tsx app/routes/warehouse.inbound-gate.test.ts app/routes/warehouse.pickup.tsx app/routes/warehouse.pickup-gate.test.ts
git commit -m "fix: preserve OUL downstream custody flow"
```

## Task 7：执行聚焦回归和类型检查

**Files:**
- Modify only if a test exposes a defect in files already listed above.

- [ ] **Step 1: 应用本地迁移**

Run: `npm run db:migrate:local`  
Expected: `0140_warehouse_packing_batches.sql` applied successfully；不得直接编辑本地数据库。

- [ ] **Step 2: 运行包装与迁移测试**

Run: `python tests/migrations/test_0140_warehouse_packing_batches.py`  
Expected: `OK`。

Run: `npx vitest run app/lib/warehouse-packing-plan.test.ts app/lib/package-identity.test.ts`  
Expected: PASS。

- [ ] **Step 3: 运行装车聚焦回归**

Run: `npx vitest run app/routes/warehouse.outbound.interaction.test.ts app/lib/warehouse-outbound-dispatch.server.test.ts app/lib/warehouse-outbound-list.test.ts app/lib/warehouse-outbound-policy.test.ts app/lib/warehouse-outbound-remediation.test.ts`  
Expected: PASS。

- [ ] **Step 4: 运行下游聚焦回归**

Run: `npx vitest run app/routes/warehouse.inbound-gate.test.ts app/routes/warehouse.pickup-gate.test.ts app/lib/overseas-inbound-policy.test.ts app/lib/warehouse-pickup-workflow-policy.test.ts`  
Expected: PASS。

- [ ] **Step 5: 运行 TypeScript 检查**

Run: `npm run typecheck`  
Expected: PASS，无 TypeScript、React Router 类型生成或 Wrangler 类型错误。

- [ ] **Step 6: 检查工作树并提交测试修正**

Run: `git status --short`  
Expected: 只包含本计划范围内的文件；不运行 `git diff --check`。

如聚焦验证产生必要修正，使用：

```powershell
git add migrations/0140_warehouse_packing_batches.sql tests/migrations/test_0140_warehouse_packing_batches.py app/lib/warehouse-packing-plan.ts app/lib/warehouse-packing-plan.test.ts app/lib/package-identity.ts app/lib/package-identity.test.ts app/routes/warehouse.outbound.tsx app/routes/warehouse.outbound.interaction.test.ts app/lib/warehouse-outbound-dispatch.server.ts app/lib/warehouse-outbound-dispatch.server.test.ts app/routes/warehouse.inbound.tsx app/routes/warehouse.inbound-gate.test.ts app/routes/warehouse.pickup.tsx app/routes/warehouse.pickup-gate.test.ts app/routes/warehouse.index.tsx app/app.css
git commit -m "test: verify warehouse packing and loading flow"
```

本计划不执行全量端到端测试、不直接写数据库、不修复历史订单；验收由项目负责人使用新建的一张整车订单和三张拼车订单手工完成。
