"""Create four LTL demo orders that are waiting for domestic warehouse acceptance.

The script targets the local Miniflare D1 database. It is intentionally
idempotent: if any of the four stable customer references already exists, it
does not write a second set.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


ORGANIZATION_ID = "33de8358-0f85-4526-8ab8-9f94ed2aafcc"
SOURCE_ORDER_NUMBER = "SO2026082500120"
DEMO_REFERENCES = [f"LTL-WAREHOUSE-DEMO-20260826-{index}" for index in range(1, 5)]


def uid() -> str:
    return str(uuid.uuid4())


def iso(offset_minutes: int = 0) -> str:
    value = datetime.now(timezone.utc) + timedelta(minutes=offset_minutes)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect() -> sqlite3.Connection:
    root = Path(".wrangler/state/v3/d1/miniflare-D1DatabaseObject")
    database = max(root.glob("*.sqlite"), key=lambda item: item.stat().st_size)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def first(connection: sqlite3.Connection, sql: str, values: tuple = ()) -> sqlite3.Row:
    row = connection.execute(sql, values).fetchone()
    if row is None:
        raise RuntimeError(f"Missing seed prerequisite: {sql} {values}")
    return row


def insert(connection: sqlite3.Connection, table: str, data: dict) -> None:
    columns = list(data)
    placeholders = ",".join("?" for _ in columns)
    connection.execute(
        f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders})",
        [data[column] for column in columns],
    )


def clone(row: sqlite3.Row, **changes) -> dict:
    data = dict(row)
    data.update(changes)
    return data


def main() -> None:
    connection = connect()
    organization_id = ORGANIZATION_ID
    source = first(
        connection,
        "SELECT * FROM transport_orders WHERE organization_id=? AND order_number=?",
        (organization_id, SOURCE_ORDER_NUMBER),
    )
    source_quote = first(connection, "SELECT * FROM quotations WHERE id=?", (source["quotation_id"],))
    source_charge = first(
        connection,
        "SELECT * FROM quotation_charges WHERE quotation_id=? ORDER BY sort_order LIMIT 1",
        (source_quote["id"],),
    )
    source_snapshot = first(connection, "SELECT * FROM transport_order_quote_snapshots WHERE order_id=?", (source["id"],))
    source_assignment = first(
        connection,
        "SELECT * FROM order_transport_assignments WHERE order_id=? AND leg_type='first_mile' ORDER BY created_at DESC LIMIT 1",
        (source["id"],),
    )
    source_vehicle = first(
        connection,
        "SELECT * FROM domestic_waybill_vehicles WHERE assignment_id=? ORDER BY vehicle_sequence LIMIT 1",
        (source_assignment["id"],),
    )
    source_shipment = first(connection, "SELECT * FROM shipments WHERE order_id=? ORDER BY created_at DESC LIMIT 1", (source["id"],))
    source_cargo = first(connection, "SELECT * FROM order_cargo_items WHERE order_id=? ORDER BY line_no LIMIT 1", (source["id"],))
    source_modules = connection.execute(
        "SELECT * FROM order_module_instances WHERE order_id=? ORDER BY created_at,module_code",
        (source["id"],),
    ).fetchall()
    source_services = connection.execute(
        "SELECT * FROM order_services WHERE order_id=? ORDER BY created_at",
        (source["id"],),
    ).fetchall()
    source_expenses = {
        row["direction"]: row
        for row in connection.execute(
            "SELECT * FROM business_expenses WHERE order_id=? AND direction IN ('receivable','payable') ORDER BY created_at",
            (source["id"],),
        )
    }
    customer = first(connection, "SELECT id,name FROM customers WHERE id=?", (source["customer_id"],))
    admin = first(connection, "SELECT id FROM users WHERE email='admin@e2e.test'")
    salesperson = first(connection, "SELECT id FROM users WHERE email='sales@e2e.test'")
    domestic_warehouse = first(
        connection,
        "SELECT id,name FROM warehouses WHERE organization_id=? AND code='HRG-01'",
        (organization_id,),
    )
    overseas_warehouse = first(
        connection,
        "SELECT id,name,address FROM warehouses WHERE organization_id=? AND code='UZ-TAS-90861'",
        (organization_id,),
    )
    workflow = first(
        connection,
        "SELECT id FROM workflow_definitions WHERE organization_id=? AND code='tms-default' AND status='active'",
        (organization_id,),
    )

    markers = ",".join("?" for _ in DEMO_REFERENCES)
    existing = connection.execute(
        f"SELECT customer_reference FROM transport_orders WHERE organization_id=? AND customer_reference IN ({markers})",
        [organization_id, *DEMO_REFERENCES],
    ).fetchall()
    if existing:
        print(json.dumps({"skipped": [row["customer_reference"] for row in existing]}, ensure_ascii=False, indent=2))
        return

    sequence: dict[str, int] = {}
    for document_type in ("quote", "order", "shipment"):
        row = first(
            connection,
            "SELECT next_value FROM document_sequences WHERE organization_id=? AND document_type=?",
            (organization_id, document_type),
        )
        sequence[document_type] = int(row["next_value"])
        connection.execute(
            "UPDATE document_sequences SET next_value=next_value+4 WHERE organization_id=? AND document_type=?",
            (organization_id, document_type),
        )

    module_state = {
        "documents": ("not_applicable", None, "文件由所属业务节点收集，文件中心仅供查询", 0, None, None),
        "consignment": ("completed", "approved", "审核通过", 100, iso(-30), iso(-25)),
        "cargo": ("completed", "confirmed", "货物确认", 100, iso(-30), iso(-25)),
        "assignment": ("completed", "assigned", "分配完成", 100, iso(-25), iso(-20)),
        "transport": ("completed", "arranged", "已录入运输安排", 100, iso(-20), iso(-10)),
        "warehouse": ("in_progress", "waiting", "待仓库扫码收货", 10, iso(-10), None),
        "loading": ("not_started", "waiting", "等待仓库确认货齐", 0, None, None),
        "costs": ("in_progress", "waiting", "等待后续费用确认", 20, iso(-20), None),
        "customs": ("not_started", "documents", "等待资料", 0, None, None),
        "tracking": ("not_started", "waiting", "等待装车出库", 0, None, None),
        "overseas_warehouse": ("not_started", "waiting_arrival", "等待到仓", 0, None, None),
        "exceptions": ("not_started", "monitoring", "异常监控", 0, None, None),
        "review": ("not_started", "waiting", "等待复盘", 0, None, None),
    }
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    created: list[dict] = []

    for index, cargo_name in enumerate(("demo1", "demo2", "demo3", "demo4"), 1):
        now = iso(index)
        quote_id, charge_id, order_id = uid(), uid(), uid()
        instance_id, assignment_id, shipment_id = uid(), uid(), uid()
        quote_number = f"QT{day}{sequence['quote'] + index - 1:05d}"
        order_number = f"SO{day}{sequence['order'] + index - 1:05d}"
        shipment_number = f"SHP{day}{sequence['shipment'] + index - 1:05d}"
        weight = 80.0 + index * 20
        length, width, height = 100.0 + index * 5, 80.0 + index * 3, 60.0 + index * 2
        volume = round(length * width * height / 1_000_000, 4)
        receivable, payable = 1200.0 + index * 150, 650.0 + index * 75
        pickup = f"中国 广东省 深圳市 南山区拼车测试提货点 {index}"
        destination_note = f"塔什干演示目的仓 · 拼车测试 {cargo_name}"

        insert(connection, "quotations", clone(
            source_quote,
            id=quote_id, quote_number=quote_number, cargo_description=cargo_name,
            pieces=1, gross_weight_kg=weight, volume_cbm=volume,
            subtotal=receivable, total_amount=receivable, status="accepted", lifecycle_status="accepted",
            road_load_type="ltl", origin_country="中国", origin_state="广东省", origin_city="深圳市",
            pickup_address=pickup, destination_country="乌兹别克斯坦", destination_state="塔什干市",
            destination_city="塔什干", destination_warehouse_id=overseas_warehouse["id"],
            destination_warehouse_note=destination_note, estimated_length_cm=length,
            estimated_width_cm=width, estimated_height_cm=height, notes="四票拼车仓库收货测试",
            created_by_user_id=admin["id"], salesperson_user_id=salesperson["id"],
            customer_contact_name="拼车测试联系人", customer_contact_phone=f"1380000000{index}",
            accepted_at=now, created_at=now, updated_at=now,
        ))
        insert(connection, "quotation_charges", clone(
            source_charge, id=charge_id, quotation_id=quote_id,
            unit_price=receivable, amount=receivable, created_at=now,
        ))
        insert(connection, "transport_orders", clone(
            source,
            id=order_id, order_number=order_number, quotation_id=quote_id,
            customer_reference=DEMO_REFERENCES[index - 1], shipper_contact="拼车测试联系人",
            shipper_phone=f"1380000000{index}", origin_country="中国", origin_state="广东省",
            origin_city="深圳市", origin_address=pickup, consignee_contact="塔什干收货联系人",
            consignee_phone=f"99890000000{index}", destination_country="乌兹别克斯坦",
            destination_state="塔什干市", destination_city="塔什干",
            destination_address=overseas_warehouse["address"] or overseas_warehouse["name"],
            cargo_description=cargo_name, pieces=1, gross_weight_kg=weight, volume_cbm=volume,
            status="in_execution", special_instructions="四票拼车测试；请从国内仓扫码收货开始继续",
            created_by_user_id=admin["id"], confirmed_at=iso(-25), created_at=now, updated_at=now,
            workflow_instance_id=None, current_step_code="module:warehouse",
            current_step_name="仓库入库 · 待仓库扫码收货", current_assignee_user_id=admin["id"],
            workflow_updated_at=now, order_date=f"{day[:4]}-{day[4:6]}-{day[6:]}", business_type="ltl",
            route_notes="深圳 → 霍尔果斯 → 塔什干", overseas_warehouse_id=overseas_warehouse["id"],
            overseas_warehouse_address_note=destination_note, salesperson_user_id=salesperson["id"],
        ))
        insert(connection, "workflow_instances", {
            "id": instance_id, "organization_id": organization_id, "workflow_id": workflow["id"],
            "customer_id": customer["id"], "quotation_id": quote_id, "order_id": order_id,
            "shipment_id": None, "invoice_id": None, "current_step_key": "warehouse_receiving",
            "status": "active", "started_at": iso(-30), "completed_at": None, "updated_at": now,
        })
        connection.execute("UPDATE transport_orders SET workflow_instance_id=? WHERE id=?", (instance_id, order_id))

        module_ids: dict[str, str] = {}
        for template in source_modules:
            code = template["module_code"]
            status, step, label, progress, started, completed = module_state[code]
            module_id = uid()
            module_ids[code] = module_id
            insert(connection, "order_module_instances", clone(
                template, id=module_id, order_id=order_id, status=status,
                current_step_code=step, current_step_name=label, progress_percent=progress,
                assignee_user_id=admin["id"], blocking_reason=None, started_at=started,
                completed_at=completed, created_at=now, updated_at=now,
            ))
        for service in source_services:
            insert(connection, "order_services", clone(service, id=uid(), order_id=order_id, created_at=now))
        insert(connection, "order_cargo_items", clone(
            source_cargo, id=uid(), order_id=order_id, cargo_name_cn=cargo_name,
            cargo_name_en=cargo_name, package_type="other", package_count=1, pieces_per_package=1,
            gross_weight_per_package_kg=weight, net_weight_per_package_kg=weight,
            length_cm=length, width_cm=width, height_cm=height, volume_per_package_cbm=volume,
            declared_value=receivable, marks=cargo_name, notes="由已接受报价自动生成；待国内仓实收",
            created_at=now, updated_at=now,
        ))

        snapshot = json.loads(source_snapshot["snapshot_json"])
        snapshot.update({
            "quoteNumber": quote_number, "cargoDescription": cargo_name, "pieces": 1,
            "grossWeightKg": weight, "volumeCbm": volume, "estimatedLengthCm": length,
            "estimatedWidthCm": width, "estimatedHeightCm": height, "pickupAddress": pickup,
            "totalAmount": receivable, "subtotal": receivable, "salespersonUserId": salesperson["id"],
        })
        snapshot["charges"] = [{
            "id": charge_id, "charge_code": "RECEIVABLE_1", "description": "国际汽运费",
            "quantity": 1, "unit_price": receivable, "amount": receivable,
            "exchange_rate": 1, "sort_order": 10,
        }]
        insert(connection, "transport_order_quote_snapshots", clone(
            source_snapshot, order_id=order_id, quotation_id=quote_id, quote_number=quote_number,
            subtotal=receivable, total_amount=receivable,
            snapshot_json=json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), created_at=now,
        ))

        insert(connection, "order_transport_assignments", clone(
            source_assignment, id=assignment_id, order_id=order_id, plate_number=f"粤BDEMO{index}",
            driver_name=f"拼车司机{index}", driver_phone=f"1390000000{index}", freight_amount=payable,
            origin_location="中国 广东省 深圳市", destination_location=domestic_warehouse["name"],
            route_country="中国 → 乌兹别克斯坦", planned_departure_at=iso(-20), planned_arrival_at=iso(-10),
            actual_departure_at=iso(-18), actual_arrival_at=iso(-8),
            loading_requirements="拼车测试货物，按订单分别验收", notes="车辆已到国内仓，等待扫码收货",
            status="arrived", created_by_user_id=admin["id"], created_at=now, updated_at=now,
            loading_mode="ltl", vehicle_count=1, destination_warehouse_id=domestic_warehouse["id"],
        ))
        insert(connection, "domestic_waybill_vehicles", clone(
            source_vehicle, id=uid(), assignment_id=assignment_id, plate_number=f"粤BDEMO{index}",
            driver_name=f"拼车司机{index}", driver_phone=f"1390000000{index}",
            planned_pickup_at=iso(-20), actual_pickup_at=iso(-18), actual_arrival_at=iso(-8),
            status="arrived", notes="等待仓库验收", created_by_user_id=admin["id"],
            created_at=now, updated_at=now,
        ))
        insert(connection, "shipments", clone(
            source_shipment, id=shipment_id, shipment_number=shipment_number, order_id=order_id,
            status="in_transit", current_location=f"{domestic_warehouse['name']}（待验收）",
            estimated_delivery_at=iso(-8), actual_pickup_at=iso(-18), actual_delivery_at=None,
            signed_by=None, exception_reason=None, created_at=now, updated_at=now,
        ))
        for event_status, location, description, event_at in (
            ("booked", "深圳市", "国内运输安排已创建", iso(-20)),
            ("picked_up", "深圳市", "国内车辆已完成提货", iso(-18)),
            ("in_transit", domestic_warehouse["name"], "车辆已到国内仓，等待验收收货", iso(-8)),
        ):
            insert(connection, "shipment_events", {
                "id": uid(), "shipment_id": shipment_id, "status": event_status,
                "location": location, "description": description, "event_at": event_at,
                "visible_to_customer": 1, "created_by_user_id": admin["id"], "created_at": now,
            })

        for direction, amount, source_id in (
            ("receivable", receivable, charge_id),
            ("payable", payable, assignment_id),
        ):
            insert(connection, "business_expenses", clone(
                source_expenses[direction], id=uid(), order_id=order_id, direction=direction,
                stage="estimated", unit_price=amount, amount=amount, base_amount=amount,
                notes=f"测试订单 {order_number}", created_by_user_id=admin["id"],
                created_at=now, updated_at=now, source_id=source_id,
            ))

        for step_key, step_name, metadata in (
            ("order_creation", "委托资料补充", {"number": order_number}),
            ("consignment_approval", "委托审核", {"seededCompleted": True}),
            ("task_assignment", "任务分配", {"seededCompleted": True}),
            ("domestic_execution", "国内运输", {"seededCompleted": True}),
            ("warehouse_receiving", "国内仓入库", {"awaitingWarehouseAcceptance": True}),
        ):
            insert(connection, "workflow_history", {
                "id": uid(), "instance_id": instance_id, "step_key": step_key,
                "step_name": step_name, "actor_user_id": admin["id"], "source": "admin",
                "metadata": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
                "occurred_at": now,
            })
        for code in ("consignment", "cargo", "assignment", "transport", "warehouse"):
            status = module_state[code]
            insert(connection, "order_module_history", {
                "id": uid(), "organization_id": organization_id, "order_id": order_id,
                "module_instance_id": module_ids[code], "action_code": "demo_seed",
                "action_name": "测试订单流程推进", "from_step_code": None,
                "to_step_code": status[1], "to_step_name": status[2], "actor_user_id": admin["id"],
                "notes": "四票拼车测试数据，停留在国内仓待扫码收货", "occurred_at": now,
            })
        created.append({
            "订单号": order_number, "报价号": quote_number, "运单号": shipment_number,
            "货物": cargo_name, "重量KG": weight, "体积CBM": volume,
        })

    connection.commit()
    print(json.dumps(created, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
