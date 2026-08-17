import json
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def now(offset=0):
    return (datetime.utcnow() + timedelta(minutes=offset)).replace(microsecond=0).isoformat() + "Z"


def uid():
    return str(uuid.uuid4())


def db_path():
    paths = [
        p
        for p in ROOT.rglob("*.sqlite")
        if "miniflare-D1DatabaseObject" in str(p) and p.name != "metadata.sqlite"
    ]
    if not paths:
        raise SystemExit("local D1 sqlite not found")
    return paths[0]


def row(con, sql, args=()):
    cur = con.execute(sql, args)
    item = cur.fetchone()
    return dict(item) if item else None


def rows(con, sql, args=()):
    return [dict(x) for x in con.execute(sql, args)]


def table_exists(con, table):
    return bool(
        row(
            con,
            "select 1 from sqlite_master where type='table' and name=?",
            (table,),
        )
    )


MODULES = [
    ("consignment", "委托信息", True, ["draft", "submitted", "approved"]),
    ("cargo", "货物信息", True, ["entered", "verified", "confirmed"]),
    ("assignment", "任务分配", True, ["pending", "partial", "assigned"]),
    ("transport", "运输安排", True, ["planning", "arranged", "ready", "completed"]),
    ("warehouse", "仓库作业", True, ["waiting", "receiving", "ready", "loading", "outbound"]),
    ("loading", "拼车配载", True, ["waiting", "selecting", "planned", "confirmed"]),
    ("documents", "文件单证", True, ["waiting", "checking", "approved", "archived"]),
    ("customs", "报关作业", True, ["documents", "ready", "declared", "review", "released"]),
    ("tracking", "运输执行与跟踪", True, ["waiting", "border_arrived", "exported", "transloaded", "transit_customs", "foreign_entered", "customs_cleared", "arrived"]),
    ("overseas_warehouse", "境外仓自提", True, ["waiting_arrival", "arrived", "notified", "appointment", "picked_up"]),
    ("costs", "费用结算", True, ["waiting", "business_review", "finance_review", "settling", "settled"]),
    ("exceptions", "异常处理", False, ["monitoring", "processing", "review", "resolved"]),
    ("review", "订单复盘", True, ["waiting", "reviewing", "confirmed"]),
]

STEP_NAMES = {
    "draft": "资料录入",
    "submitted": "提交审批",
    "approved": "审核通过",
    "entered": "货物录入",
    "verified": "货物复核",
    "confirmed": "确认完成",
    "pending": "待分配",
    "partial": "部分分配",
    "assigned": "分配完成",
    "planning": "运输安排",
    "arranged": "已录入运输安排",
    "ready": "已齐套，待配载/出库",
    "completed": "完成",
    "waiting": "等待处理",
    "selecting": "选择可配载订单",
    "planned": "配载成单",
    "checking": "资料检查",
    "archived": "文件归档",
    "documents": "等待资料",
    "declared": "完成申报",
    "review": "审核",
    "released": "已放行",
    "departed": "已登记发车",
    "border_arrived": "到达出境口岸",
    "exported": "出境",
    "transloaded": "换装",
    "transit_customs": "转关",
    "foreign_entered": "国外入境",
    "customs_cleared": "目的地清关完成",
    "transit": "运输在途",
    "arrived": "目的仓已到仓",
    "signed": "完成签收",
    "waiting_arrival": "等待到仓",
    "notified": "客户已通知",
    "appointment": "预约提货",
    "picked_up": "提货完成",
    "business_review": "业务审核",
    "finance_review": "财务审核",
    "settling": "结算处理",
    "settled": "结算完成",
    "monitoring": "异常监控",
    "processing": "异常处理",
    "reviewing": "复盘中",
    "outbound": "装车出库交接",
    "loading": "按配载批次装车",
    "receiving": "到仓收货",
}

LTL_STAGES = [
    ("order_creation", "订单创建"),
    ("review_assignment", "审核分配"),
    ("domestic_execution", "国内运输"),
    ("port_loading", "口岸配载"),
    ("outbound_transport", "出境运输"),
    ("overseas_pickup", "境外仓自提"),
    ("reconciliation", "对账结算"),
    ("completion_review", "完成复盘"),
]
FTL_STAGES = [x for x in LTL_STAGES if x[0] != "port_loading"]


def ensure_workflows(con, org):
    for code, name, stages in [
        ("tms-default", "拼车型汽运订单标准流程", LTL_STAGES),
        ("tms-ftl-standard", "整车型汽运订单标准流程", FTL_STAGES),
    ]:
        wf_id = f"{org}:{code}"
        con.execute(
            "insert or ignore into workflow_definitions(id,organization_id,code,name,status,created_at,updated_at) values(?,?,?,?,?,?,?)",
            (wf_id, org, code, name, "active", now(), now()),
        )
        con.execute(
            "update workflow_definitions set name=?,status='active',updated_at=? where id=?",
            (name, now(), wf_id),
        )
        for index, (key, label) in enumerate(stages, 1):
            con.execute(
                "insert or ignore into workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,is_required,is_active,actor_scope,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"{org}:wf:{code}:{key}", wf_id, key, label, "order", f"manual.{key}", index * 10, 1, 1, "admin", now(), now()),
            )
            con.execute(
                "update workflow_steps set name=?,sort_order=?,is_active=1,updated_at=? where id=?",
                (label, index * 10, now(), f"{org}:wf:{code}:{key}"),
            )


def module_enabled(code, business_type):
    return not (code == "loading" and business_type == "ftl")


def create_order(con, ctx, index, business_type):
    org, customer, admin, overseas = ctx["org"], ctx["customer"], ctx["admin"], ctx["overseas"]
    order_id = uid()
    prefix = "AUTO-LTL" if business_type == "ltl" else "AUTO-FTL"
    order_number = f"{prefix}-{datetime.utcnow():%m%d%H%M%S}-{index:02d}"
    workflow_id = f"{org}:tms-default" if business_type == "ltl" else f"{org}:tms-ftl-standard"
    workflow_instance_id = uid()
    t = now(index)
    con.execute(
        """insert into transport_orders(
          id,organization_id,order_number,customer_id,customer_reference,shipper_name,shipper_contact,shipper_phone,
          origin_country,origin_state,origin_city,origin_address,consignee_name,consignee_contact,consignee_phone,
          destination_country,destination_state,destination_city,destination_address,cargo_description,pieces,gross_weight_kg,volume_cbm,
          transport_mode,service_level,requested_pickup_date,requested_delivery_date,status,source,special_instructions,
          created_by_user_id,confirmed_at,created_at,updated_at,workflow_instance_id,current_step_code,current_step_name,current_assignee_user_id,
          workflow_updated_at,is_overdue,exception_status,order_date,business_nature,business_type,transport_terms,trade_terms,exit_port,transit_locations,
          customs_location,route_notes,overseas_warehouse_id,overseas_warehouse_address_note,completion_status)
          values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            order_id, org, order_number, customer["id"], f"SMOKE-{business_type.upper()}-{index}",
            "深圳测试工厂", "测试发货人", "13800000000", "CN", "广东省", "深圳市", "深圳市测试仓库",
            "塔什干收货人", "境外联系人", "998900000000", "UZ", "塔什干市", "塔什干", "塔什干目的仓",
            f"{business_type.upper()} 自动穿透测试货物", 2, 100 + index * 10, 1.2 + index / 10,
            "road", "standard", "2026-08-13", "2026-08-20", "draft", "admin", "自动穿透测试",
            admin["id"], None, t, t, None, "module:consignment", "委托信息 · 资料录入", admin["id"],
            t, 0, "normal", "2026-08-13", "export", business_type, "door_to_door", "DAP", "CN-XJ-KH", "阿拉木图",
            "深圳清关", "自动测试线路", overseas["id"], "自动测试目的仓地址", "in_progress",
        ),
    )
    con.execute(
        "insert into workflow_instances(id,organization_id,workflow_id,customer_id,order_id,current_step_key,status,started_at,updated_at) values(?,?,?,?,?,?,?,?,?)",
        (workflow_instance_id, org, workflow_id, customer["id"], order_id, "order_creation", "active", t, t),
    )
    con.execute(
        "update transport_orders set workflow_instance_id=? where id=?",
        (workflow_instance_id, order_id),
    )
    for code, name, required, steps in MODULES:
        enabled = module_enabled(code, business_type)
        step = steps[0]
        con.execute(
            "insert into order_module_instances(id,organization_id,order_id,module_code,module_name,workflow_version,enabled,is_required,status,current_step_code,current_step_name,progress_percent,assignee_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (uid(), org, order_id, code, name, 1, 1 if enabled else 0, 1 if required else 0,
             "not_started" if enabled else "not_applicable", step if enabled else None, STEP_NAMES.get(step, step) if enabled else "本单无需拼车配载", 0,
             admin["id"] if enabled else None, t, t),
        )
    services = ["pickup", "warehouse", "packing", "customs", "destination_customs", "destination_warehouse", "other"]
    for s in services:
        con.execute("insert into order_services(id,organization_id,order_id,service_code,service_name,status,created_at) values(?,?,?,?,?,?,?)",
                    (uid(), org, order_id, s, s, "requested", t))
    cargo_id = uid()
    con.execute(
        "insert into order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,cargo_name_en,hs_code,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,origin_country,brand_model,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cargo_id, org, order_id, 1, f"{business_type.upper()} 测试件", "Smoke cargo", "847989", "pallet", 2, 1, 50 + index * 5, 48 + index * 5, 100, 80, 75, 0.6 + index / 20, 1000 + index * 100, "USD", "CN", "AUTO-SMOKE", t, t),
    )
    package_ids = []
    for n in range(1, 3):
        pid = uid()
        package_ids.append(pid)
        con.execute("insert into order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,status,created_at) values(?,?,?,?,?,?,?,?)",
                    (pid, org, order_id, cargo_id, f"{order_number}-P{n:03d}", n, "planned", t))
    return {"id": order_id, "order_number": order_number, "business_type": business_type, "packages": package_ids}


def set_module(con, org, order_id, code, status, step, progress=100):
    con.execute(
        "update order_module_instances set status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=null,started_at=coalesce(started_at,?),completed_at=case when ?='completed' then coalesce(completed_at,?) else completed_at end,updated_at=? where organization_id=? and order_id=? and module_code=?",
        (status, step, STEP_NAMES.get(step, step), progress, now(), status, now(), now(), org, order_id, code),
    )


def set_stage(con, org, order_id, stage, title):
    con.execute(
        "update transport_orders set current_step_code=?,current_step_name=?,current_assignee_user_id=?,workflow_updated_at=?,updated_at=? where organization_id=? and id=?",
        (stage, title, row(con, "select created_by_user_id from transport_orders where id=?", (order_id,))["created_by_user_id"], now(), now(), org, order_id),
    )


def common_until_ready(con, ctx, order):
    org, admin, carrier, wh, loc = ctx["org"], ctx["admin"], ctx["carrier"], ctx["domestic"], ctx["location"]
    oid = order["id"]
    t = now()
    con.execute("update transport_orders set status='submitted',current_step_code='review_assignment',current_step_name='审核分配',updated_at=? where id=?", (t, oid))
    set_module(con, org, oid, "consignment", "completed", "approved")
    set_module(con, org, oid, "cargo", "completed", "confirmed")
    con.execute("update transport_orders set status='in_execution',confirmed_at=?,current_assignee_user_id=?,updated_at=? where id=?", (t, admin["id"], t, oid))
    set_module(con, org, oid, "assignment", "completed", "assigned")
    set_stage(con, org, oid, "domestic_execution", "国内运输")
    con.execute(
        "insert into shipments(id,organization_id,shipment_number,order_id,customer_id,status,current_location,created_at,updated_at) values(?,?,?,?,?,?,?,?,?)",
        (uid(), org, "SHP-" + order["order_number"], oid, ctx["customer"]["id"], "booked", "深圳测试工厂", t, t),
    )
    ship = row(con, "select id from shipments where order_id=?", (oid,))
    con.execute(
        "insert into order_transport_assignments(id,organization_id,order_id,leg_type,carrier_id,carrier_name,vehicle_type,plate_number,driver_name,driver_phone,freight_amount,freight_currency,origin_location,destination_location,border_port,planned_departure_at,planned_arrival_at,actual_departure_at,actual_arrival_at,status,created_by_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (uid(), org, oid, "first_mile", carrier["id"], carrier["name"], "厢式货车", "粤B-SMOKE", "国内司机", "13900000000", 1800, "CNY", "深圳测试工厂", "霍尔果斯普通仓", "CN-XJ-KH", now(10), now(100), now(15), now(120), "arrived", admin["id"], t, t),
    )
    set_module(con, org, oid, "transport", "completed", "completed")
    rec_id = uid()
    con.execute(
        "insert into warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,total_packages,total_pieces,total_weight_kg,total_volume_cbm,notes,received_by_user_id,received_at,created_at,updated_at,package_type) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rec_id, org, "RCPT-" + order["order_number"], ship["id"], wh["id"], loc["id"], "completed", 2, 2, 100, 1.2, "自动测试收货", ctx["warehouse_user"]["id"], now(130), t, t, "pallet"),
    )
    for i, pid in enumerate(order["packages"], 1):
        wp = uid()
        con.execute("insert into warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,weight_kg,volume_cbm,status,notes,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (wp, org, rec_id, ship["id"], wh["id"], loc["id"], f"OUL-SMOKE-{order['order_number']}-{i}", f"{order['order_number']}-P{i}", 1, 50, 0.6, "in_stock", "自动测试", t, t))
        con.execute("update order_cargo_packages set status='received' where id=?", (pid,))
    sort_id = uid()
    con.execute("insert into warehouse_sorting_batches(id,organization_id,batch_number,shipment_id,target_location_id,status,notes,created_by_user_id,verified_by_user_id,created_at,updated_at,verified_at) values(?,?,?,?,?,?,?,?,?,?,?,?)",
                (sort_id, org, "SORT-" + order["order_number"], ship["id"], loc["id"], "verified", "自动齐套复核", ctx["warehouse_user"]["id"], ctx["warehouse_user"]["id"], t, t, now(140)))
    for wp in rows(con, "select id from warehouse_packages where receipt_id=?", (rec_id,)):
        con.execute("insert into warehouse_sorting_items(id,organization_id,batch_id,package_id,status,sorted_by_user_id,verified_by_user_id,sorted_at,verified_at) values(?,?,?,?,?,?,?,?,?)",
                    (uid(), org, sort_id, wp["id"], "verified", ctx["warehouse_user"]["id"], ctx["warehouse_user"]["id"], now(135), now(140)))
    set_module(con, org, oid, "warehouse", "in_progress", "ready", 50)


def add_docs_customs_costs(con, ctx, order, complete_cost=True):
    org, admin, oid = ctx["org"], ctx["admin"], order["id"]
    att = uid()
    con.execute("insert into order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) values(?,?,?,?,?,?,?,?,?,?,?)",
                (att, org, oid, ctx["customer"]["id"], "pre-departure-smoke.pdf", "application/pdf", 32, "data:application/pdf;base64,JVBERg==", admin["id"], "admin", now()))
    con.execute("insert or replace into order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,reviewed_by_user_id,reviewed_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)",
                (att, org, oid, "customs", "自动测试资料", 0, "approved", admin["id"], now(), now()))
    set_module(con, org, oid, "documents", "completed", "archived")
    if table_exists(con, "customs_clearances"):
        for stage in ["origin", "destination"]:
            con.execute("insert into customs_clearances(id,organization_id,order_id,clearance_stage,declaration_mode,broker_name,declaration_number,status,declared_at,released_at,inspection_result,notes,created_by_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (uid(), org, oid, stage, "transfer", "测试报关行", f"CUS-{order['order_number']}-{stage}", "released", now(), now(), "released", "自动测试放行", admin["id"], now(), now()))
    set_module(con, org, oid, "customs", "completed", "released")
    for direction, amount in [("receivable", 3000), ("payable", 1800)]:
        con.execute("insert into business_expenses(id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,created_by_user_id,created_at,updated_at,tax_rate,tax_amount,is_internal) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uid(), org, oid, direction, "settled" if complete_cost else "estimated", "ROAD", "汽运费", ctx["customer"]["name"] if direction == "receivable" else ctx["carrier"]["name"], "USD", 1, amount, amount, 1, amount, "自动测试费用", admin["id"], now(), now(), 0, 0, 0))
        con.execute("insert or replace into order_expense_direction_controls(organization_id,order_id,direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked,confirmed_by_user_id,business_reviewed_by_user_id,finance_reviewed_by_user_id,business_locked_by_user_id,finance_locked_by_user_id,confirmed_at,business_reviewed_at,finance_reviewed_at,business_locked_at,finance_locked_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (org, oid, direction, 1, 1, 1, 1, 1 if complete_cost else 0, admin["id"], admin["id"], admin["id"], admin["id"], admin["id"] if complete_cost else None, now(), now(), now(), now(), now() if complete_cost else None, now()))
    set_module(con, org, oid, "costs", "completed" if complete_cost else "in_progress", "settled" if complete_cost else "finance_review", 100 if complete_cost else 60)


def create_ltl_batch(con, ctx, batch_orders, batch_index):
    org, admin, carrier, wh = ctx["org"], ctx["admin"], ctx["carrier"], ctx["domestic"]
    batch_id = uid()
    batch_no = f"AUTO-LOAD-{datetime.utcnow():%m%d%H%M%S}-{batch_index}"
    con.execute("insert into transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,planned_departure_at,planned_arrival_at,status,notes,created_at,updated_at,route_key,warehouse_id,carrier_id,created_by_user_id,border_port,transit_location,route_notes,road_status) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (batch_id, org, batch_orders[0]["id"], batch_no, batch_no, "CN 广东省 深圳市", "UZ 塔什干市 塔什干", now(300), now(3000), "loading", "自动配载单", now(), now(), "cn|guangdong|shenzhen>uz|tashkent|tashkent", wh["id"], carrier["id"], admin["id"], "CN-XJ-KH", "阿拉木图", "自动测试", "loaded_waiting_exit"))
    vehicle_id = uid()
    con.execute("insert into transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,plate_number,carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_type) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (vehicle_id, org, batch_id, "V1", "粤B-LTL", carrier["id"], "拼车司机", "13911111111", 30000, 90, "loading", now(), now(), "厢式卡车"))
    for seq, o in enumerate(batch_orders, 1):
        con.execute("insert into transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?)",
                    (uid(), org, batch_id, o["id"], seq, "assigned", admin["id"], now(), now()))
        for pkg in rows(con, "select id from order_cargo_packages where order_id=? and status!='cancelled'", (o["id"],)):
            con.execute("insert into transport_vehicle_loads(id,organization_id,batch_id,vehicle_id,package_id,loaded_at,created_by_user_id,created_at) values(?,?,?,?,?,?,?,?)",
                        (uid(), org, batch_id, vehicle_id, pkg["id"], now(), admin["id"], now()))
        set_module(con, org, o["id"], "loading", "completed", "confirmed")
    return batch_id


def dispatch_warehouse(con, ctx, order, batch_id=None):
    org, wu, carrier = ctx["org"], ctx["warehouse_user"], ctx["carrier"]
    ship = row(con, "select id from shipments where order_id=?", (order["id"],))
    sortb = row(con, "select id from warehouse_sorting_batches where shipment_id=?", (ship["id"],))
    d_id = uid()
    con.execute("insert into warehouse_dispatches(id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,driver_name,driver_phone,carrier_name,seal_number,destination,status,notes,created_by_user_id,dispatched_by_user_id,created_at,updated_at,dispatched_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (d_id, org, "DSP-" + order["order_number"], sortb["id"], ship["id"], "粤B-LTL" if batch_id else "粤B-FTL", "出库司机", "13922222222", carrier["name"], "SEAL-SMOKE", "霍尔果斯口岸", "dispatched", "自动装车出库", wu["id"], wu["id"], now(), now(), now()))
    for pkg in rows(con, "select p.id from warehouse_packages p where p.shipment_id=?", (ship["id"],)):
        con.execute("insert into warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status,loaded_by_user_id,loaded_at) values(?,?,?,?,?,?,?)",
                    (uid(), org, d_id, pkg["id"], "loaded", wu["id"], now()))
    set_module(con, org, order["id"], "warehouse", "completed", "outbound")


def finish_ltl(con, ctx, batch_id, batch_orders):
    org, admin = ctx["org"], ctx["admin"]
    con.execute("update transport_batches set status='departed',road_status='outbound_in_transit',actual_departure_at=?,updated_at=? where id=?", (now(), now(), batch_id))
    for o in batch_orders:
        set_module(con, org, o["id"], "tracking", "in_progress", "transit", 50)
    con.execute("update transport_batches set status='arrived',road_status='waiting_pickup',actual_arrival_at=?,updated_at=? where id=?", (now(500), now(), batch_id))
    for o in batch_orders:
        con.execute("insert into overseas_warehouse_operations(id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,notified_at,appointment_at,pickup_at,pickup_contact,pickup_proof_reference,notes,updated_by_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uid(), org, batch_id, o["id"], ctx["overseas"]["id"], "picked_up", now(500), now(510), now(520), now(530), "客户自提人", "PICK-SMOKE", "自动境外仓自提", admin["id"], now(), now()))
        set_module(con, org, o["id"], "tracking", "completed", "arrived")
        set_module(con, org, o["id"], "overseas_warehouse", "completed", "picked_up")
        add_docs_customs_costs(con, ctx, o, True)
        set_module(con, org, o["id"], "exceptions", "completed", "resolved")
        set_module(con, org, o["id"], "review", "completed", "confirmed")
        con.execute("update transport_orders set status='completed',completion_status='completed_settled',business_completed_at=?,settlement_completed_at=?,current_step_code='completed',current_step_name='已完成',updated_at=? where id=?",
                    (now(), now(), now(), o["id"]))


def finish_ftl(con, ctx, order, complete=True):
    org, admin = ctx["org"], ctx["admin"]
    dispatch_warehouse(con, ctx, order, None)
    batch_id = uid()
    batch_no = f"AUTO-FTL-LOAD-{datetime.utcnow():%m%d%H%M%S}-{order['order_number'][-2:]}"
    con.execute("insert into transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,planned_departure_at,planned_arrival_at,status,notes,created_at,updated_at,route_key,warehouse_id,carrier_id,created_by_user_id,border_port,transit_location,route_notes,road_status) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (batch_id, org, order["id"], batch_no, batch_no, "CN 广东省 深圳市", "UZ 塔什干市 塔什干", now(300), now(3000), "arrived" if complete else "departed", "自动整车直装批次", now(), now(), "cn|guangdong|shenzhen>uz|tashkent|tashkent", ctx["domestic"]["id"], ctx["carrier"]["id"], admin["id"], "CN-XJ-KH", "阿拉木图", "自动测试整车", "waiting_pickup" if complete else "outbound_in_transit"))
    con.execute("insert into transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?)",
                (uid(), org, batch_id, order["id"], 1, "arrived" if complete else "departed", admin["id"], now(), now()))
    add_docs_customs_costs(con, ctx, order, complete)
    set_module(con, org, order["id"], "tracking", "completed", "arrived")
    con.execute("insert into overseas_warehouse_operations(id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,notified_at,appointment_at,pickup_at,pickup_contact,pickup_proof_reference,notes,updated_by_user_id,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid(), org, batch_id, order["id"], ctx["overseas"]["id"], "picked_up" if complete else "arrived", now(500), now(510) if complete else None, now(520) if complete else None, now(530) if complete else None, "客户自提人" if complete else None, "PICK-SMOKE" if complete else None, "自动整车境外仓", admin["id"], now(), now()))
    set_module(con, org, order["id"], "overseas_warehouse", "completed" if complete else "in_progress", "picked_up" if complete else "arrived", 100 if complete else 25)
    if complete:
        set_module(con, org, order["id"], "exceptions", "completed", "resolved")
        set_module(con, org, order["id"], "review", "completed", "confirmed")
        con.execute("update transport_orders set status='completed',completion_status='completed_settled',business_completed_at=?,settlement_completed_at=?,current_step_code='completed',current_step_name='已完成',updated_at=? where id=?",
                    (now(), now(), now(), order["id"]))
    else:
        set_stage(con, org, order["id"], "overseas_pickup", "境外仓自提")


def snapshot(con, order):
    mods = rows(con, "select module_code,status,current_step_code,progress_percent from order_module_instances where order_id=? order by module_code", (order["id"],))
    return {
        "order_number": order["order_number"],
        "business_type": order["business_type"],
        "loading_enabled": any(m["module_code"] == "loading" and m["status"] != "not_applicable" for m in mods),
        "order": row(con, "select status,current_step_code,current_step_name from transport_orders where id=?", (order["id"],)),
        "pending_modules": [m for m in mods if m["status"] not in ("completed", "not_applicable")],
    }


def main():
    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    con.execute("pragma foreign_keys=on")
    ctx = {}
    ctx["admin"] = row(con, "select id,display_name from users where email='admin@e2e.test'")
    ctx["warehouse_user"] = row(con, "select id,display_name from users where email='ucrstore01@e2e.test'")
    ctx["org"] = row(con, "select organization_id from memberships where user_id=?", (ctx["admin"]["id"],))["organization_id"]
    ctx["customer"] = row(con, "select id,name from customers where name='E2E Client Company'")
    ctx["carrier"] = row(con, "select id,name from carriers where name='E2E Carrier'")
    ctx["domestic"] = (
        row(con, "select w.id,w.name from warehouses w where w.organization_id=? and w.warehouse_role='domestic_collection' and w.status='active' and exists(select 1 from warehouse_locations l where l.warehouse_id=w.id and l.status='active') order by w.code limit 1", (ctx["org"],))
        or row(con, "select w.id,w.name from warehouses w where w.organization_id=? and w.country_code='CN' and w.status='active' and exists(select 1 from warehouse_locations l where l.warehouse_id=w.id and l.status='active') order by w.code limit 1", (ctx["org"],))
    )
    ctx["overseas"] = (
        row(con, "select id,name from warehouses where organization_id=? and warehouse_role='overseas_destination' and status='active' order by code limit 1", (ctx["org"],))
        or row(con, "select id,name from warehouses where organization_id=? and country_code='UZ' and status='active' order by code limit 1", (ctx["org"],))
    )
    ctx["location"] = row(con, "select id,name from warehouse_locations where warehouse_id=? order by code limit 1", (ctx["domestic"]["id"],))
    missing = [key for key in ["admin", "warehouse_user", "customer", "carrier", "domestic", "overseas", "location"] if not ctx.get(key)]
    if missing:
        raise SystemExit(f"missing seed data: {missing}")
    ensure_workflows(con, ctx["org"])

    ltl_orders = [create_order(con, ctx, i, "ltl") for i in range(1, 7)]
    ftl_orders = [create_order(con, ctx, i, "ftl") for i in range(1, 4)]
    for o in ltl_orders + ftl_orders:
        common_until_ready(con, ctx, o)

    batches = []
    for i in range(3):
        pair = ltl_orders[i * 2:i * 2 + 2]
        batch_id = create_ltl_batch(con, ctx, pair, i + 1)
        for o in pair:
            dispatch_warehouse(con, ctx, o, batch_id)
        finish_ltl(con, ctx, batch_id, pair)
        batches.append(batch_id)

    finish_ftl(con, ctx, ftl_orders[0], True)
    finish_ftl(con, ctx, ftl_orders[1], True)
    finish_ftl(con, ctx, ftl_orders[2], False)

    report = {
        "created": {
            "ltl": [o["order_number"] for o in ltl_orders],
            "ftl": [o["order_number"] for o in ftl_orders],
            "batches": [row(con, "select batch_number from transport_batches where id=?", (b,))["batch_number"] for b in batches],
        },
        "checks": [snapshot(con, o) for o in ltl_orders[:3] + ftl_orders],
    }
    con.commit()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
