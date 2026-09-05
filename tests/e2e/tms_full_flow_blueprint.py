"""Auditable plan for one FTL plus three LTL orders in one PZ batch.

This module is deliberately a *plan*, not a claim that the flow has passed.
Executable page-object handlers must be attached case by case and must run via
``RoleBrowserSession``.  The plan follows the test-case fields described in the
user-supplied software-testing methodology article.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

from tms_ui_harness import CasePriority, GateExpectation, Site


CaseKind = Literal["preflight", "happy_path", "negative_gate", "foolproof"]


@dataclass(frozen=True, slots=True)
class ScenarioCase:
    case_id: str
    title: str
    priority: CasePriority
    kind: CaseKind
    stage: str
    role: str
    site: Site
    preconditions: tuple[str, ...]
    inputs: Mapping[str, Any]
    actions: tuple[str, ...]
    expected_result: str
    gate: GateExpectation | None = None
    entity_effects: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ("步骤截图", "角色 trace", "JSON 行为日志")


def workflow_gate(
    name: str,
    *,
    mode: Literal["required", "optional", "hidden", "read_only"],
    behavior: Literal["allow", "block", "hide", "read_only"],
    ui: str,
    server: str,
    owner: str,
    module_state: bool = False,
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source=(
            "workflow_instance_module_state"
            if module_state
            else "workflow_instance_field_configuration"
        ),
        configured_mode=mode,
        expected_behavior=behavior,
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="先核对订单工作流实例配置和当前值，再由该配置统一修正 UI 提示与服务端门禁",
    )


def permission_gate(
    name: str,
    *,
    behavior: Literal["allow", "block", "hide", "read_only"],
    ui: str,
    server: str,
    owner: str,
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source="role_permission_configuration",
        configured_mode="read_only" if behavior == "read_only" else "not_applicable",
        expected_behavior=behavior,
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对岗位权限积木、个人权限覆盖和订单/配载单负责人范围",
    )


FULL_FLOW_CASES: tuple[ScenarioCase, ...] = (
    ScenarioCase(
        "PRE-001", "18 个账号分站点登录与导航权限冒烟", "P0", "preflight", "前置检查",
        "system", "admin", ("服务端已启动", "凭据由运行时文件或环境变量提供"),
        {"credential_source": "runtime-only"},
        ("逐账号建立独立浏览器上下文", "使用可见登录页键盘输入", "检查应显示与应隐藏的菜单"),
        "全部账号进入正确站点；菜单与岗位权限配置一致；无意外 403。",
        permission_gate(
            "岗位菜单与站点权限", behavior="allow",
            ui="只展示该账号有权使用的入口，无权入口直接隐藏",
            server="对应首页可访问，跨站点或越权深链仍被拒绝",
            owner="系统管理员",
        ),
    ),
    ScenarioCase(
        "CUST-001", "业务岗创建全新客户、联系人和默认地址", "P0", "happy_path", "客户建档",
        "sales", "admin", ("业务岗已登录",), {"customer_name": "{entity_prefix}-客户"},
        ("从侧栏进入客户管理", "点击新增客户", "键盘填写企业、联系人与地址", "提交并从页面读取客户标识"),
        "一次提交创建全新客户，页面可回看联系人和地址；不复用旧客户。",
        entity_effects=("create:customer",),
    ),
    ScenarioCase(
        "QUOTE-FTL-001", "为新客户创建一票整车报价", "P0", "happy_path", "询价报价",
        "sales", "admin", ("CUST-001 通过",), {"business_type": "FTL", "cargo": "整车货物"},
        ("通过侧栏进入询价与报价", "选择新客户", "按当前工作流可见字段填写", "保存报价"),
        "生成唯一整车报价，绑定当前已发布整车工作流版本。",
        workflow_gate(
            "报价字段门禁", mode="required", behavior="allow",
            ui="仅显示工作流中启用的字段，必填项有一致标识",
            server="已填写全部当前必填字段时允许保存",
            owner="业务岗",
        ),
        ("create:quote:ftl",),
    ),
    ScenarioCase(
        "QUOTE-LTL-001", "创建第一票拼车报价", "P0", "happy_path", "询价报价",
        "sales", "admin", ("CUST-001 通过",), {"business_type": "LTL", "cargo": "拼车货物 1"},
        ("点击新建报价", "选择同一新客户", "填写第一票独立货物与费用", "保存"),
        "生成第一张独立拼车报价。",
        workflow_gate("拼车报价字段门禁", mode="required", behavior="allow", ui="必填字段取自拼车工作流配置", server="字段齐全后允许保存", owner="业务岗"),
        ("create:quote:ltl",),
    ),
    ScenarioCase(
        "QUOTE-LTL-002", "创建第二票拼车报价", "P0", "happy_path", "询价报价",
        "sales", "admin", ("QUOTE-LTL-001 通过",), {"business_type": "LTL", "cargo": "拼车货物 2"},
        ("点击新建报价", "填写第二票独立货物与费用", "保存"),
        "生成第二张独立拼车报价。",
        workflow_gate("拼车报价字段门禁", mode="required", behavior="allow", ui="必填字段取自拼车工作流配置", server="字段齐全后允许保存", owner="业务岗"),
        ("create:quote:ltl",),
    ),
    ScenarioCase(
        "QUOTE-LTL-003", "创建第三票拼车报价", "P0", "happy_path", "询价报价",
        "sales", "admin", ("QUOTE-LTL-002 通过",), {"business_type": "LTL", "cargo": "拼车货物 3"},
        ("点击新建报价", "填写第三票独立货物与费用", "保存"),
        "生成第三张独立拼车报价。",
        workflow_gate("拼车报价字段门禁", mode="required", behavior="allow", ui="必填字段取自拼车工作流配置", server="字段齐全后允许保存", owner="业务岗"),
        ("create:quote:ltl",),
    ),
    ScenarioCase(
        "QUOTE-NEG-001", "报价必填项与隐藏项防呆", "P0", "foolproof", "询价报价",
        "sales", "admin", ("至少打开一份未提交报价",), {"field_modes": "从订单工作流配置现场读取"},
        ("清空一个当前必填字段尝试提交", "确认当前隐藏字段没有控件", "恢复必填值"),
        "必填字段缺失时 UI 和服务端同时阻断；隐藏字段没有控件且不能影响提交。",
        workflow_gate("必填/隐藏字段一致性", mode="required", behavior="block", ui="显示具体缺失字段；隐藏字段无入口", server="拒绝缺必填值的提交", owner="业务岗"),
    ),
    ScenarioCase(
        "PORTAL-ACCEPT-001", "客户门户接受四份报价并生成四张订单", "P0", "happy_path", "报价确认",
        "customer", "portal", ("四份报价均已保存",), {"quote_count": 4},
        ("从门户首页进入待确认报价", "逐份核对并接受", "从页面记录四个订单号"),
        "每份报价仅生成一张订单：1 张 FTL、3 张 LTL。",
        workflow_gate("客户报价确认", mode="required", behavior="allow", ui="待客户确认时展示唯一确认入口", server="每个报价幂等生成一张订单", owner="客户"),
        ("create:order:ftl", "create:order:ltl", "create:order:ltl", "create:order:ltl"),
    ),
    ScenarioCase(
        "PORTAL-ACCEPT-NEG-001", "重复确认报价不重复建单", "P0", "foolproof", "报价确认",
        "customer", "portal", ("PORTAL-ACCEPT-001 通过",), {"quote_count": 1},
        ("返回已接受报价", "尝试再次寻找确认入口"),
        "确认入口已消失；订单数量不增加。",
        GateExpectation("报价幂等门禁", "system_integrity_invariant", "not_applicable", "hide", "已接受报价不显示再次确认按钮", "重复提交不会生成第二张订单", "系统", "检查幂等键与 UI 状态投影"),
    ),
    ScenarioCase(
        "CONSIGN-001", "客户补充四张订单委托资料并提请审批", "P0", "happy_path", "委托资料补充",
        "customer", "portal", ("四张订单已生成",), {"order_count": 4},
        ("逐单进入委托资料", "按工作流可见字段上传/填写", "提请审批"),
        "四张订单进入委托审核；选填字段不阻断，隐藏字段不出现。",
        workflow_gate("委托资料完整性", mode="required", behavior="allow", ui="提示只列当前工作流必填缺口", server="必填齐全后允许提请审批", owner="客户"),
    ),
    ScenarioCase(
        "APPROVE-001", "业务主管审核四张委托", "P0", "happy_path", "委托审核",
        "business_supervisor", "admin", ("CONSIGN-001 通过",), {"order_count": 4},
        ("从任务工作台进入待审核", "逐单只查看审批所需资料", "审批通过"),
        "审批通过后进入任务分配；业务岗同一页面只读且无伪操作按钮。",
        permission_gate("委托审核办理权限", behavior="allow", ui="主管显示审核控件，业务岗仅显示实时状态表", server="仅获授权且在范围内的主管可提交", owner="业务主管"),
    ),
    ScenarioCase(
        "ASSIGN-001", "操作主管为四张普通订单分配初始负责人", "P0", "happy_path", "任务分配",
        "operation_supervisor", "admin", ("APPROVE-001 通过",), {"order_count": 4},
        ("普通订单页签查看未分配订单", "给 FTL 和三张 LTL 分配操作员、单证"),
        "所有订单进入执行岗位；分配历史保留并显示状态标签。",
        workflow_gate("任务分配节点", mode="required", behavior="allow", ui="当前工作流要求负责人时显示分配入口", server="负责人齐全后推进", owner="操作主管", module_state=True),
    ),
    ScenarioCase(
        "DOMESTIC-001", "操作岗完成四张订单国内运输安排", "P0", "happy_path", "国内运输",
        "operation", "admin", ("ASSIGN-001 通过",), {"order_count": 4},
        ("从普通订单页签逐单进入", "登记车辆司机和提货节点", "确认运抵国内仓"),
        "四张订单转入国内仓待入库，普通订单列表实时更新。",
        workflow_gate("国内运输字段", mode="required", behavior="allow", ui="只提示当前工作流所需运输字段", server="必填齐全才完成国内运输模块", owner="操作岗"),
    ),
    ScenarioCase(
        "WH-INBOUND-001", "国内仓扫码接收并确认四张订单货齐", "P0", "happy_path", "国内仓入库",
        "domestic_warehouse", "warehouse", ("DOMESTIC-001 通过",), {"order_count": 4},
        ("进入验收收货", "逐票键盘/扫码枪输入货物码", "登记实收数据", "确认货齐"),
        "四张订单均完成国内仓入库，状态同步到后台。",
        workflow_gate("国内仓入库模块", mode="required", behavior="allow", ui="未扫齐时明确显示缺失货码", server="全部必需货物扫码且实收字段齐全后完成", owner="国内仓", module_state=True),
    ),
    ScenarioCase(
        "WH-SCAN-NEG-001", "错误及重复货物码防呆", "P0", "foolproof", "国内仓入库",
        "domestic_warehouse", "warehouse", ("存在待入库货物",), {"scan_cases": ["错误码", "重复码"]},
        ("输入不属于当前订单的货物码", "再次输入已扫描货物码"),
        "错误码被拒绝；重复码不重复累计；提示明确且可恢复继续作业。",
        GateExpectation("扫码唯一性", "system_integrity_invariant", "not_applicable", "block", "错误/重复扫码即时提示", "库存与件数不重复写入", "仓库岗", "检查扫码幂等和订单归属校验"),
    ),
    ScenarioCase(
        "FTL-LOAD-001", "国内仓创建并完成整车装车任务", "P0", "happy_path", "整车装车出库",
        "domestic_warehouse", "warehouse", ("FTL 已确认货齐",), {"business_type": "FTL"},
        ("进入普通订单在仓待装", "选择整车订单创建装车任务", "扫码装车", "最终确认出库交接"),
        "整车订单完成装车出库并转入报关放行。",
        workflow_gate("整车装车出库", mode="required", behavior="allow", ui="文件/货物/车辆缺口与工作流配置一致", server="必办项完成并最终确认后推进", owner="国内仓", module_state=True),
    ),
    ScenarioCase(
        "PZ-CREATE-001", "国内仓将三张拼车订单生成一个 PZ 配载单", "P0", "happy_path", "创建配载单",
        "domestic_warehouse", "warehouse", ("三张 LTL 均已确认货齐",), {"ltl_order_count": 3},
        ("进入货物配载", "勾选三张 LTL", "登记车辆司机与线路", "生成并提交 PZ"),
        "一个 PZ 只挂载这三张全新 LTL；文件自动同步；待操作主管审批分配。",
        workflow_gate("配载单创建", mode="required", behavior="allow", ui="配载条件从三张订单当前工作流和批次状态汇总", server="仅三票都满足条件时生成 PZ", owner="国内仓", module_state=True),
        ("create:pz:three-ltl",),
    ),
    ScenarioCase(
        "PZ-ASSIGN-001", "操作主管按配载单统一分配操作员与单证", "P0", "happy_path", "配载单任务分配",
        "operation_supervisor", "admin", ("PZ-CREATE-001 通过",), {"batch_count": 1, "order_count": 3},
        ("切到配载订单页签", "展开 PZ 挂载订单与货物码", "统一分配新操作员和单证"),
        "新负责人接管 PZ 下三票后续业务；原订单负责人自动解除；历史完整保留。",
        permission_gate("配载单统一交接权限", behavior="allow", ui="主管在配载页签看到整批分配入口", server="一次原子更新整批负责人和订单关系", owner="操作主管"),
    ),
    ScenarioCase(
        "PZ-LOAD-001", "国内仓按 PZ 创建装车任务并整批出库", "P0", "happy_path", "拼车装车出库",
        "domestic_warehouse", "warehouse", ("PZ-ASSIGN-001 通过",), {"batch_order_count": 3},
        ("进入配载单装车", "核对三票货物标签和货物码", "全部扫码装车", "最终确认整批出库"),
        "PZ 及三张挂载订单同时更新到报关节点；不再作为普通订单重复出现。",
        workflow_gate("配载整批出库", mode="required", behavior="allow", ui="未扫齐时提示具体订单/货码，完成后显示下一岗位", server="三票全部完成才原子推进", owner="国内仓", module_state=True),
    ),
    ScenarioCase(
        "CUSTOMS-FTL-001", "单证岗办理整车报关并确认放行", "P0", "happy_path", "报关放行",
        "document", "admin", ("FTL-LOAD-001 通过",), {"scope": "FTL"},
        ("从普通订单进入报关与文件", "按工作流补齐逐票资料", "新增报关单", "确认海关放行"),
        "整车报关完成；非单证岗位只读；下一步清晰指向操作岗运踪。",
        workflow_gate("整车报关资料", mode="required", behavior="allow", ui="红色只标记单证岗当前必办且必填内容", server="当前必填报关资料齐全才放行", owner="单证岗"),
    ),
    ScenarioCase(
        "CUSTOMS-PZ-001", "单证岗在 PZ 页面办理三票逐票报关", "P0", "happy_path", "报关放行",
        "document", "admin", ("PZ-LOAD-001 通过",), {"scope": "PZ", "order_count": 3},
        ("进入配载单报关页签", "逐票查看本票文件", "分别登记报关单并确认放行"),
        "三票逐票报关状态清晰；整批共用文件只读；全部放行后批次可出境。",
        workflow_gate("PZ 逐票报关", mode="required", behavior="allow", ui="每票提示取自各自工作流实例", server="三票必填资料分别校验，全部放行后解除批次门禁", owner="单证岗"),
    ),
    ScenarioCase(
        "EXIT-NEG-001", "未全部放行不能确认出境", "P0", "negative_gate", "实际出境",
        "operation", "admin", ("PZ 至少一票尚未放行",), {"scope": "PZ"},
        ("从正常菜单进入 PZ 运踪", "尝试登记实际出境"),
        "页面预先解释未放行票数并阻断；服务端同样拒绝。",
        workflow_gate("出境前置模块", mode="required", behavior="block", ui="显示尚未完成的工作流模块/票号", server="拒绝越过未完成的报关模块", owner="操作岗", module_state=True),
    ),
    ScenarioCase(
        "EXIT-TRACK-001", "操作岗登记 FTL 与 PZ 实际出境及运踪", "P0", "happy_path", "实际出境及运踪",
        "operation", "admin", ("FTL 和 PZ 所有报关均放行",), {"transport_units": 2},
        ("分别进入普通订单与配载订单", "登记口岸到达和实际出境", "连续登记境外运输节点"),
        "四张订单实时同步境外运输状态，PZ 三票不重复操作。",
        workflow_gate("出境与运踪节点", mode="required", behavior="allow", ui="下一动作按当前工作流顺序展示", server="前置模块完成且必填节点齐全后推进", owner="操作岗", module_state=True),
    ),
    ScenarioCase(
        "OVERSEAS-INBOUND-001", "境外仓扫码入库并确认四票货齐", "P0", "happy_path", "境外仓入库",
        "overseas_warehouse", "warehouse", ("运输节点到达目的仓",), {"order_count": 4},
        ("进入境外仓验收收货", "逐票扫码", "登记实收", "确认货齐"),
        "四票进入待客户预约自提；后台与客户门户实时更新。",
        workflow_gate("境外仓入库", mode="required", behavior="allow", ui="扫码缺口和必填实收项来自工作流实例", server="货物齐全且字段满足时完成", owner="境外仓", module_state=True),
    ),
    ScenarioCase(
        "PICKUP-APPOINT-001", "客户在门户预约四票自提", "P0", "happy_path", "客户自提",
        "customer", "portal", ("四票均已境外仓入库",), {"order_count": 4},
        ("进入我的订单", "逐票选择预约时间与提货人", "提交预约"),
        "境外仓实时收到预约；客户页面明确下一步由仓库扫码交付。",
        workflow_gate("客户自提预约", mode="required", behavior="allow", ui="当前配置要求预约时显示表单与清晰责任人", server="必填预约信息齐全后登记", owner="客户"),
    ),
    ScenarioCase(
        "PICKUP-SIGN-001", "境外仓扫码交付并完成签收", "P0", "happy_path", "客户自提签收",
        "overseas_warehouse", "warehouse", ("PICKUP-APPOINT-001 通过",), {"order_count": 4},
        ("打开待自提", "核对预约与提货人", "逐票扫码交付", "登记签收凭证"),
        "业务执行完成并转入费用结算；客户门户显示签收完成。",
        workflow_gate("自提签收", mode="required", behavior="allow", ui="只显示当前配置要求的签收字段", server="必填签收资料齐全后完成业务模块", owner="境外仓", module_state=True),
    ),
    ScenarioCase(
        "COST-CS-001", "客服确认四票客户应收应付资料", "P0", "happy_path", "三方结算",
        "customer_service", "admin", ("四票业务执行完成",), {"order_count": 4},
        ("从费用结算或任务工作台进入", "核对费用方向与资料", "完成客服确认"),
        "当前工作流启用且要求的客服确认完成；其他未启用字段不显示也不阻断。",
        workflow_gate("客服费用确认", mode="required", behavior="allow", ui="提示/标色只对应客服当前必办字段", server="按实例字段模式决定是否阻断", owner="客服岗"),
    ),
    ScenarioCase(
        "COST-BIZ-001", "业务岗审核本人四票业务费用", "P0", "happy_path", "三方结算",
        "sales", "admin", ("COST-CS-001 通过",), {"order_count": 4},
        ("从本人订单费用页进入", "仅查看对客摘要", "完成业务审核"),
        "业务岗可完成配置要求的审核，但不可见内部应付账号和利润。",
        workflow_gate("业务费用审核", mode="required", behavior="allow", ui="业务岗仅展示必需的对客摘要和审核控件", server="仅本人订单且字段启用时接受", owner="业务岗"),
    ),
    ScenarioCase(
        "COST-FIN-001", "财务审核并生成对账单与发票记录", "P0", "happy_path", "三方结算",
        "finance", "admin", ("客服与业务所需确认完成",), {"order_count": 4},
        ("进入待对账", "按往来单位和币种生成对账单", "财务审核", "登记开票"),
        "应收/应付和对账状态同步到四票；门禁由各订单费用字段配置决定。",
        workflow_gate("财务审核/对账/开票", mode="required", behavior="allow", ui="工作区仅突出当前必办字段并解释下一岗位", server="逐订单实例配置校验后推进", owner="财务会计岗"),
    ),
    ScenarioCase(
        "COST-CASH-001", "出纳登记收付款并核销", "P0", "happy_path", "三方结算",
        "cashier", "admin", ("对账与发票达到当前配置要求",), {"order_count": 4},
        ("进入收付款工作区", "登记实际流水", "关联并核销订单费用"),
        "余额和费用状态实时同步；出纳无财务审核控件。",
        workflow_gate("收付款与核销", mode="required", behavior="allow", ui="仅当实例字段启用时出现，必填时提示阻断", server="按 required/optional/hidden 动态判断完成状态", owner="出纳岗"),
    ),
    ScenarioCase(
        "COST-CONFIG-001", "费用字段必填/选填/隐藏动态同步", "P0", "foolproof", "三方结算",
        "developer", "admin", ("存在尚未完成复盘的测试订单",), {"modes": ["required", "optional", "hidden"]},
        ("通过工作流配置页面切换一个费用字段模式", "刷新对应岗位页面", "观察提示、控件与门禁", "恢复原配置"),
        "required 显示且阻断；optional 显示但不阻断；hidden 不显示且服务端拒绝该动作；当前订单即时同步。",
        workflow_gate("费用字段动态模式", mode="required", behavior="block", ui="标识、提示、按钮随配置即时变化", server="同一配置决定动作可用性与完成门禁", owner="开发者"),
    ),
    ScenarioCase(
        "REVIEW-001", "财务完成复盘并归档四票", "P0", "happy_path", "复盘归档",
        "finance", "admin", ("所有当前 required 费用字段已完成", "业务执行已完成"), {"order_count": 4},
        ("进入订单复盘同级页签", "核对时效/货量/费用/异常", "完成复盘", "归档"),
        "四票进入完成归档；订单复盘与异常处理可同级切换；无未结算循环。",
        workflow_gate("完成复盘门禁", mode="required", behavior="allow", ui="只列当前工作流仍缺失的模块或字段", server="全部 required 项完成才允许归档", owner="财务会计岗", module_state=True),
    ),
    ScenarioCase(
        "SCOPE-NEG-001", "跨账号订单和配载单范围防越权", "P0", "negative_gate", "权限审计",
        "sales", "admin", ("存在不属于当前业务员的订单和 PZ",), {"negative_navigation": "explicit-gate-only"},
        ("从无权账号列表确认目标不可见", "仅为负向门禁测试使用记录原因的站内深链"),
        "列表、详情、文件和办理动作使用同一范围规则；无权访问返回 403/404 且不泄露敏感数据。",
        permission_gate("订单/配载单范围", behavior="block", ui="无权数据不出现在列表和搜索建议", server="详情、文件、动作均拒绝越权", owner="系统管理员"),
    ),
)


REQUIRED_MILESTONES = (
    "CUST-001",
    "QUOTE-FTL-001",
    "QUOTE-LTL-001",
    "QUOTE-LTL-002",
    "QUOTE-LTL-003",
    "PORTAL-ACCEPT-001",
    "CONSIGN-001",
    "APPROVE-001",
    "ASSIGN-001",
    "DOMESTIC-001",
    "WH-INBOUND-001",
    "FTL-LOAD-001",
    "PZ-CREATE-001",
    "PZ-ASSIGN-001",
    "PZ-LOAD-001",
    "CUSTOMS-FTL-001",
    "CUSTOMS-PZ-001",
    "EXIT-TRACK-001",
    "OVERSEAS-INBOUND-001",
    "PICKUP-APPOINT-001",
    "PICKUP-SIGN-001",
    "COST-CS-001",
    "COST-BIZ-001",
    "COST-FIN-001",
    "COST-CASH-001",
    "REVIEW-001",
)


def validate_blueprint(cases: Sequence[ScenarioCase] = FULL_FLOW_CASES) -> list[str]:
    errors: list[str] = []
    ids = [item.case_id for item in cases]
    if len(set(ids)) != len(ids):
        errors.append("用例 ID 不唯一")
    cursor = -1
    for milestone in REQUIRED_MILESTONES:
        try:
            index = ids.index(milestone)
        except ValueError:
            errors.append(f"缺少主线里程碑 {milestone}")
            continue
        if index <= cursor:
            errors.append(f"主线里程碑顺序错误：{milestone}")
        cursor = index
    effects = [effect for item in cases for effect in item.entity_effects]
    if effects.count("create:customer") != 1:
        errors.append("每个 attempt 必须新建且只新建一个主客户")
    if effects.count("create:quote:ftl") != 1:
        errors.append("必须规划一张整车报价")
    if effects.count("create:quote:ltl") != 3:
        errors.append("必须规划三张拼车报价")
    if effects.count("create:order:ftl") != 1 or effects.count("create:order:ltl") != 3:
        errors.append("必须由报价确认生成一张整车订单和三张拼车订单")
    if effects.count("create:pz:three-ltl") != 1:
        errors.append("三张拼车订单必须组成且只组成一个 PZ")
    for item in cases:
        if not item.title.strip() or not item.expected_result.strip() or not item.actions:
            errors.append(f"{item.case_id} 缺少标题、步骤或预期结果")
        if item.gate and item.gate.source.startswith("workflow_instance"):
            if "工作流" not in (item.gate.ui_expectation + item.gate.server_expectation + item.gate.remediation):
                errors.append(f"{item.case_id} 的业务门禁没有明确绑定工作流实例配置")
    if not any(item.kind == "negative_gate" for item in cases):
        errors.append("缺少负向门禁用例")
    if not any(item.kind == "foolproof" for item in cases):
        errors.append("缺少防呆用例")
    return errors


def planned_payload(cases: Sequence[ScenarioCase] = FULL_FLOW_CASES) -> dict[str, Any]:
    errors = validate_blueprint(cases)
    return {
        "schema": "international-tms-five-order-plan/v1",
        "status": "PLANNED_NOT_EXECUTED",
        "methodology_reference": "https://blog.csdn.net/IGGIRing/article/details/106093982",
        "certification_rule": "任何修复后必须使用新 attempt、新客户、新报价和新订单从头运行",
        "errors": errors,
        "case_count": len(cases),
        "cases": [asdict(item) for item in cases],
    }


def write_planned_payload(destination: Path | str) -> Path:
    path = Path(destination).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(planned_payload(), ensure_ascii=False, indent=2),
        encoding="utf-8-sig",
    )
    return path


__all__ = [
    "FULL_FLOW_CASES",
    "REQUIRED_MILESTONES",
    "ScenarioCase",
    "planned_payload",
    "validate_blueprint",
    "write_planned_payload",
]
