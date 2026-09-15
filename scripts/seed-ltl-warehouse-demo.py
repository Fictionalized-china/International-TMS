"""Create configurable LTL demo orders already received and waiting for consolidation.

The script targets the local Miniflare D1 database. It is intentionally
idempotent: existing demo orders are repaired to the same post-receipt state
instead of creating a second set.

Use LTL_DEMO_COUNT and LTL_DEMO_PREFIX to create an isolated test set.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


ORGANIZATION_ID = "33de8358-0f85-4526-8ab8-9f94ed2aafcc"
SOURCE_ORDER_NUMBER = "SO2026082500120"
DEFAULT_REFERENCE_PREFIX = "LTL-WAREHOUSE-DEMO-20260826"


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


def ensure_workflow_snapshot(
    connection: sqlite3.Connection,
    order_id: str,
) -> None:
    """Freeze the configured workflow exactly as a normal order creation does."""
    instance = first(
        connection,
        "SELECT id,workflow_id,current_step_key,started_at,updated_at FROM workflow_instances WHERE order_id=?",
        (order_id,),
    )
    now = iso()
    connection.execute(
        """INSERT OR IGNORE INTO workflow_instance_step_states(
             id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,
             started_at,completed_at,updated_at
           )
           SELECT lower(hex(randomblob(16))),?,?,s.id,s.step_key,s.name,s.sort_order,
             CASE
               WHEN s.sort_order<current.sort_order THEN 'completed'
               WHEN s.step_key=? THEN 'active'
               ELSE 'pending'
             END,
             CASE WHEN s.sort_order<=current.sort_order THEN ? ELSE NULL END,
             CASE WHEN s.sort_order<current.sort_order THEN ? ELSE NULL END,
             ?
           FROM workflow_steps s
           JOIN workflow_steps current
             ON current.workflow_id=s.workflow_id AND current.step_key=? AND current.is_active=1
           WHERE s.workflow_id=? AND s.is_active=1""",
        (
            instance["id"], instance["workflow_id"], instance["current_step_key"],
            instance["started_at"], instance["updated_at"], now,
            instance["current_step_key"], instance["workflow_id"],
        ),
    )
    connection.execute(
        """INSERT OR IGNORE INTO workflow_instance_module_states(
             id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,
             is_required,status,responsibility_position_code,completion_mode,updated_at
           )
           SELECT lower(hex(randomblob(16))),ss.id,m.id,m.module_code,m.display_name,m.sort_order,
             m.is_required,
             CASE ss.status WHEN 'completed' THEN 'completed' WHEN 'active' THEN 'active' ELSE 'pending' END,
             m.responsibility_position_code,m.completion_mode,?
           FROM workflow_instance_step_states ss
           JOIN workflow_step_modules m
             ON m.workflow_id=ss.workflow_id AND m.step_id=ss.step_id AND m.is_active=1
           WHERE ss.instance_id=?""",
        (now, instance["id"]),
    )
    connection.execute(
        """INSERT OR IGNORE INTO workflow_instance_task_states(
             id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,
             is_required,status,responsibility_position_code,instructions,completed_at,updated_at
           )
           SELECT lower(hex(randomblob(16))),ms.id,t.id,t.task_key,t.name,t.task_type,t.sort_order,
             t.is_required,
             CASE ss.status WHEN 'completed' THEN 'completed' WHEN 'active' THEN 'active' ELSE 'pending' END,
             COALESCE(t.responsibility_position_code,ms.responsibility_position_code),t.instructions,
             CASE WHEN ss.status='completed' THEN ? ELSE NULL END,?
           FROM workflow_instance_module_states ms
           JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
           JOIN workflow_module_tasks t
             ON t.workflow_id=ss.workflow_id AND t.step_module_id=ms.step_module_id AND t.is_active=1
           WHERE ss.instance_id=?""",
        (now, now, instance["id"]),
    )
    connection.execute(
        """UPDATE workflow_instance_task_states
           SET assignee_user_id=(
             SELECT omi.assignee_user_id
             FROM workflow_instance_module_states ms
             JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
             JOIN workflow_instances wi ON wi.id=ss.instance_id
             JOIN order_module_instances omi
               ON omi.organization_id=wi.organization_id
              AND omi.order_id=wi.order_id
              AND omi.module_code=ms.module_code
              AND omi.enabled=1
             WHERE ms.id=workflow_instance_task_states.instance_module_state_id
           )
           WHERE instance_module_state_id IN (
             SELECT ms.id FROM workflow_instance_module_states ms
             JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
             WHERE ss.instance_id=?
           )""",
        (instance["id"],),
    )
    connection.execute(
        """INSERT OR IGNORE INTO workflow_instance_fields(
             id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
             is_required,is_active,sort_order,options_text,help_text,created_at
           )
           SELECT lower(hex(randomblob(16))),?,f.workflow_id,s.step_key,
             COALESCE(f.module_code,'consignment'),f.field_key,f.label,f.field_type,
             f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,?
           FROM workflow_step_fields f
           JOIN workflow_steps s ON s.id=f.step_id AND s.workflow_id=f.workflow_id
           WHERE f.workflow_id=?""",
        (instance["id"], now, instance["workflow_id"]),
    )


def ensure_warehouse_received(
    connection: sqlite3.Connection,
    order: sqlite3.Row,
    domestic_warehouse: sqlite3.Row,
    admin_id: str,
) -> dict:
    """Materialize the same data produced by a normal domestic receipt."""
    now = iso()
    order_id = order["id"]
    order_number = order["order_number"]
    shipment = first(
        connection,
        "SELECT * FROM shipments WHERE order_id=? ORDER BY created_at DESC LIMIT 1",
        (order_id,),
    )
    cargo = first(
        connection,
        "SELECT * FROM order_cargo_items WHERE order_id=? ORDER BY line_no LIMIT 1",
        (order_id,),
    )
    location = first(
        connection,
        "SELECT * FROM warehouse_locations WHERE warehouse_id=? AND status='active' ORDER BY created_at LIMIT 1",
        (domestic_warehouse["id"],),
    )

    receipt = connection.execute(
        "SELECT * FROM warehouse_receipts WHERE shipment_id=? AND warehouse_id=? AND status='completed' ORDER BY created_at DESC LIMIT 1",
        (shipment["id"], domestic_warehouse["id"]),
    ).fetchone()
    if receipt is None:
        receipt_id = uid()
        receipt_number = f"IN-DEMO-{order_number[-8:]}"
        insert(connection, "warehouse_receipts", {
            "id": receipt_id,
            "organization_id": order["organization_id"],
            "receipt_number": receipt_number,
            "shipment_id": shipment["id"],
            "warehouse_id": domestic_warehouse["id"],
            "location_id": location["id"],
            "status": "completed",
            "total_packages": 1,
            "total_pieces": int(cargo["package_count"] or 1) * int(cargo["pieces_per_package"] or 1),
            "total_weight_kg": float(cargo["gross_weight_per_package_kg"] or 0),
            "total_volume_cbm": float(cargo["volume_per_package_cbm"] or 0),
            "notes": "拼车测试货物已完成仓库验收",
            "received_by_user_id": admin_id,
            "received_at": now,
            "created_at": now,
            "updated_at": now,
            "package_type": cargo["package_type"] or "other",
            "evidence_note": None,
            "cargo_complete": 1,
            "has_exception": 0,
            "exception_notes": None,
        })
        insert(connection, "warehouse_receipt_items", {
            "id": uid(),
            "organization_id": order["organization_id"],
            "receipt_id": receipt_id,
            "order_id": order_id,
            "cargo_item_id": cargo["id"],
            "expected_packages": int(cargo["package_count"] or 1),
            "expected_pieces": int(cargo["package_count"] or 1) * int(cargo["pieces_per_package"] or 1),
            "expected_weight_kg": float(cargo["gross_weight_per_package_kg"] or 0),
            "expected_volume_cbm": float(cargo["volume_per_package_cbm"] or 0),
            "actual_packages": int(cargo["package_count"] or 1),
            "actual_pieces": int(cargo["package_count"] or 1) * int(cargo["pieces_per_package"] or 1),
            "actual_weight_kg": float(cargo["gross_weight_per_package_kg"] or 0),
            "actual_volume_cbm": float(cargo["volume_per_package_cbm"] or 0),
            "result": "normal",
            "notes": None,
            "created_at": now,
            "updated_at": now,
            "actual_length_cm": float(cargo["length_cm"] or 0),
            "actual_width_cm": float(cargo["width_cm"] or 0),
            "actual_height_cm": float(cargo["height_cm"] or 0),
        })
        receipt = first(connection, "SELECT * FROM warehouse_receipts WHERE id=?", (receipt_id,))
    else:
        connection.execute(
            "UPDATE warehouse_receipts SET cargo_complete=1,has_exception=0,exception_notes=NULL,updated_at=? WHERE id=?",
            (now, receipt["id"]),
        )

    package = connection.execute(
        "SELECT * FROM warehouse_packages WHERE shipment_id=? AND warehouse_id=? ORDER BY created_at LIMIT 1",
        (shipment["id"], domestic_warehouse["id"]),
    ).fetchone()
    if package is None:
        package_id = uid()
        barcode = f"OUL-DEMO-{order_number[-8:]}"
        insert(connection, "warehouse_packages", {
            "id": package_id,
            "organization_id": order["organization_id"],
            "receipt_id": receipt["id"],
            "shipment_id": shipment["id"],
            "warehouse_id": domestic_warehouse["id"],
            "location_id": location["id"],
            "barcode": barcode,
            "package_number": f"PK-{order_number[1:]}-1-1-DEMO",
            "pieces": int(cargo["package_count"] or 1) * int(cargo["pieces_per_package"] or 1),
            "weight_kg": float(cargo["gross_weight_per_package_kg"] or 0),
            "volume_cbm": float(cargo["volume_per_package_cbm"] or 0),
            "status": "in_stock",
            "notes": "拼车测试货物已入库待配载",
            "created_at": now,
            "updated_at": now,
            "parent_package_id": None,
            "cargo_item_id": cargo["id"],
            "length_cm": float(cargo["length_cm"] or 0),
            "width_cm": float(cargo["width_cm"] or 0),
            "height_cm": float(cargo["height_cm"] or 0),
        })
        package = first(connection, "SELECT * FROM warehouse_packages WHERE id=?", (package_id,))
    else:
        connection.execute(
            "UPDATE warehouse_packages SET status='in_stock',receipt_id=?,location_id=?,updated_at=? WHERE id=?",
            (receipt["id"], location["id"], now, package["id"]),
        )
        barcode = package["barcode"]

    batch = connection.execute(
        "SELECT * FROM warehouse_sorting_batches WHERE shipment_id=? AND status!='cancelled' ORDER BY created_at DESC LIMIT 1",
        (shipment["id"],),
    ).fetchone()
    if batch is None:
        batch_id = uid()
        insert(connection, "warehouse_sorting_batches", {
            "id": batch_id,
            "organization_id": order["organization_id"],
            "batch_number": f"SORT-DEMO-{order_number[-8:]}",
            "shipment_id": shipment["id"],
            "target_location_id": location["id"],
            "status": "verified",
            "notes": "验收确认货齐，自动进入待配载队列",
            "created_by_user_id": admin_id,
            "verified_by_user_id": admin_id,
            "created_at": now,
            "updated_at": now,
            "verified_at": now,
        })
        batch = first(connection, "SELECT * FROM warehouse_sorting_batches WHERE id=?", (batch_id,))
    else:
        connection.execute(
            "UPDATE warehouse_sorting_batches SET target_location_id=?,status='verified',verified_by_user_id=?,verified_at=COALESCE(verified_at,?),updated_at=? WHERE id=?",
            (location["id"], admin_id, now, now, batch["id"]),
        )
    sorting_item = connection.execute(
        "SELECT id FROM warehouse_sorting_items WHERE batch_id=? AND package_id=?",
        (batch["id"], package["id"]),
    ).fetchone()
    if sorting_item is None:
        insert(connection, "warehouse_sorting_items", {
            "id": uid(),
            "organization_id": order["organization_id"],
            "batch_id": batch["id"],
            "package_id": package["id"],
            "status": "verified",
            "sorted_by_user_id": admin_id,
            "verified_by_user_id": admin_id,
            "sorted_at": now,
            "verified_at": now,
            "notes": "验收确认货齐，自动纳入配载范围",
        })

    connection.execute(
        "UPDATE shipments SET status='picked_up',current_location=?,actual_pickup_at=COALESCE(actual_pickup_at,?),updated_at=? WHERE id=?",
        (f"{domestic_warehouse['name']} / {location['name']}", now, now, shipment["id"]),
    )
    connection.execute(
        "UPDATE transport_orders SET current_step_code='module:loading',current_step_name='出口准备与装车出库 · 仓库已收货待配载',workflow_updated_at=?,updated_at=? WHERE id=?",
        (now, now, order_id),
    )
    connection.execute(
        "UPDATE workflow_instances SET current_step_key='port_loading',updated_at=? WHERE order_id=?",
        (now, order_id),
    )
    connection.execute(
        "UPDATE order_module_instances SET status='completed',current_step_code='warehouse_arrived',current_step_name='货物已到国内仓',progress_percent=100,completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE order_id=? AND module_code='transport' AND enabled=1",
        (now, now, order_id),
    )
    connection.execute(
        "UPDATE order_module_instances SET status='completed',current_step_code='ready',current_step_name='收货清点完成',progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE order_id=? AND module_code='warehouse' AND enabled=1",
        (now, now, now, order_id),
    )
    connection.execute(
        "UPDATE order_module_instances SET status='not_started',current_step_code='waiting',current_step_name='仓库已收货，待拼车配载',progress_percent=0,completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE order_id=? AND module_code='loading' AND enabled=1",
        (now, order_id),
    )

    workflow_instance = first(connection, "SELECT id FROM workflow_instances WHERE order_id=?", (order_id,))
    has_history = connection.execute(
        "SELECT 1 FROM workflow_history WHERE instance_id=? AND step_key='port_loading' LIMIT 1",
        (workflow_instance["id"],),
    ).fetchone()
    if has_history is None:
        insert(connection, "workflow_history", {
            "id": uid(),
            "instance_id": workflow_instance["id"],
            "step_key": "port_loading",
            "step_name": "出口准备与装车出库",
            "actor_user_id": admin_id,
            "source": "system",
            "metadata": json.dumps({"receiptNumber": receipt["receipt_number"], "cargoComplete": True}, ensure_ascii=False),
            "occurred_at": now,
        })
    return {"barcode": barcode, "receipt_number": receipt["receipt_number"]}


def main() -> None:
    requested_count = int(os.environ.get("LTL_DEMO_COUNT", "4"))
    if requested_count < 1 or requested_count > 20:
        raise ValueError("LTL_DEMO_COUNT must be between 1 and 20")
    reference_prefix = os.environ.get("LTL_DEMO_PREFIX", DEFAULT_REFERENCE_PREFIX).strip()
    if not reference_prefix:
        raise ValueError("LTL_DEMO_PREFIX cannot be empty")
    demo_references = [f"{reference_prefix}-{index}" for index in range(1, requested_count + 1)]
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
    operation_supervisor = first(connection, "SELECT id FROM users WHERE email='operation-supervisor@e2e.test'")
    operation_user = first(connection, "SELECT id FROM users WHERE email='operation@e2e.test'")
    document_user = first(connection, "SELECT id FROM users WHERE email='doc@e2e.test'")
    customer_service_user = first(connection, "SELECT id FROM users WHERE email='cs@e2e.test'")
    finance_user = first(connection, "SELECT id FROM users WHERE email='finance@e2e.test'")
    domestic_warehouse = first(
        connection,
        "SELECT id,name FROM warehouses WHERE organization_id=? AND code='HRG-01'",
        (organization_id,),
    )
    overseas_warehouse = first(
        connection,
        "SELECT id,name,address FROM warehouses WHERE organization_id=? AND code='UZ-TAS-01' AND status='active'",
        (organization_id,),
    )
    workflow = first(
        connection,
        """SELECT id FROM workflow_definitions
           WHERE organization_id=? AND road_load_type='ltl' AND status='active'
             AND lifecycle_status='published'
           ORDER BY version_number DESC, updated_at DESC LIMIT 1""",
        (organization_id,),
    )

    markers = ",".join("?" for _ in demo_references)
    existing = connection.execute(
        f"SELECT * FROM transport_orders WHERE organization_id=? AND customer_reference IN ({markers}) ORDER BY customer_reference",
        [organization_id, *demo_references],
    ).fetchall()
    if existing:
        if len(existing) != len(demo_references):
            raise RuntimeError("Only part of the stable LTL demo set exists; repair the incomplete set before reseeding")
        repaired = []
        for order in existing:
            connection.execute(
                "UPDATE transport_orders SET operation_supervisor_user_id=?,current_assignee_user_id=NULL,updated_at=? WHERE id=?",
                (operation_supervisor["id"], iso(), order["id"]),
            )
            module_assignees = {
                "consignment": salesperson["id"],
                "assignment": operation_supervisor["id"],
                "transport": operation_user["id"],
                "tracking": operation_user["id"],
                "exceptions": operation_user["id"],
                "customs": document_user["id"],
                "costs": customer_service_user["id"],
                "review": finance_user["id"],
            }
            for module_code, assignee_user_id in module_assignees.items():
                connection.execute(
                    "UPDATE order_module_instances SET assignee_user_id=?,updated_at=? WHERE order_id=? AND module_code=? AND enabled=1",
                    (assignee_user_id, iso(), order["id"], module_code),
                )
            receipt_state = ensure_warehouse_received(
                connection,
                order,
                domestic_warehouse,
                admin["id"],
            )
            ensure_workflow_snapshot(connection, order["id"])
            repaired.append({
                "订单号": order["order_number"],
                "货物": order["cargo_description"],
                "入库单": receipt_state["receipt_number"],
                "货物条码": receipt_state["barcode"],
                "状态": "仓库已收货待配载",
            })
        connection.commit()
        print(json.dumps(repaired, ensure_ascii=False, indent=2))
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
            "UPDATE document_sequences SET next_value=next_value+? WHERE organization_id=? AND document_type=?",
            (requested_count, organization_id, document_type),
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

    for index in range(1, requested_count + 1):
        cargo_name = f"LTL ready cargo {index}"
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
        destination_note = f"塔什干目的仓 · 拼车测试 {cargo_name}"

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
            customer_reference=demo_references[index - 1], shipper_contact="拼车测试联系人",
            shipper_phone=f"1380000000{index}", origin_country="中国", origin_state="广东省",
            origin_city="深圳市", origin_address=pickup, consignee_contact="塔什干收货联系人",
            consignee_phone=f"99890000000{index}", destination_country="乌兹别克斯坦",
            destination_state="塔什干市", destination_city="塔什干",
            destination_address=overseas_warehouse["address"] or overseas_warehouse["name"],
            cargo_description=cargo_name, pieces=1, gross_weight_kg=weight, volume_cbm=volume,
            status="in_execution", special_instructions="四票拼车测试；请从国内仓扫码收货开始继续",
            created_by_user_id=admin["id"], confirmed_at=iso(-25), created_at=now, updated_at=now,
            workflow_instance_id=None, current_step_code="module:warehouse",
            current_step_name="仓库入库 · 待仓库扫码收货", current_assignee_user_id=None,
            workflow_updated_at=now, order_date=f"{day[:4]}-{day[4:6]}-{day[6:]}", business_type="ltl",
            route_notes="深圳 → 霍尔果斯 → 塔什干", overseas_warehouse_id=overseas_warehouse["id"],
            overseas_warehouse_address_note=destination_note, salesperson_user_id=salesperson["id"],
            operation_supervisor_user_id=operation_supervisor["id"],
        ))
        insert(connection, "workflow_instances", {
            "id": instance_id, "organization_id": organization_id, "workflow_id": workflow["id"],
            "customer_id": customer["id"], "quotation_id": quote_id, "order_id": order_id,
            "shipment_id": None, "invoice_id": None, "current_step_key": "warehouse_receiving",
            "status": "active", "started_at": iso(-30), "completed_at": None, "updated_at": now,
        })
        connection.execute("UPDATE transport_orders SET workflow_instance_id=? WHERE id=?", (instance_id, order_id))

        module_ids: dict[str, str] = {}
        module_assignees = {
            "consignment": salesperson["id"],
            "assignment": operation_supervisor["id"],
            "transport": operation_user["id"],
            "tracking": operation_user["id"],
            "exceptions": operation_user["id"],
            "customs": document_user["id"],
            "costs": customer_service_user["id"],
            "review": finance_user["id"],
        }
        for template in source_modules:
            code = template["module_code"]
            status, step, label, progress, started, completed = module_state[code]
            module_id = uid()
            module_ids[code] = module_id
            insert(connection, "order_module_instances", clone(
                template, id=module_id, order_id=order_id, status=status,
                current_step_code=step, current_step_name=label, progress_percent=progress,
                assignee_user_id=module_assignees.get(code), blocking_reason=None, started_at=started,
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
        receipt_state = ensure_warehouse_received(
            connection,
            first(connection, "SELECT * FROM transport_orders WHERE id=?", (order_id,)),
            domestic_warehouse,
            admin["id"],
        )
        ensure_workflow_snapshot(connection, order_id)
        created.append({
            "订单号": order_number, "报价号": quote_number, "运单号": shipment_number,
            "货物": cargo_name, "重量KG": weight, "体积CBM": volume,
            "入库单": receipt_state["receipt_number"], "货物条码": receipt_state["barcode"],
            "状态": "仓库已收货待配载",
        })

    connection.commit()
    print(json.dumps(created, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
