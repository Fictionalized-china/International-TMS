-- 承运商主数据扩展：司机和车辆台账
-- 后续配载/运输安排中的车牌司机输入改为从这些主数据下拉选择，不再重复手输

CREATE TABLE carrier_drivers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  carrier_id TEXT NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  license_number TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, carrier_id, name)
);
CREATE INDEX idx_carrier_drivers_carrier ON carrier_drivers(carrier_id, status);

CREATE TABLE carrier_vehicles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  carrier_id TEXT NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  plate_number TEXT NOT NULL,
  vehicle_type TEXT,
  capacity_weight_kg REAL NOT NULL DEFAULT 0 CHECK (capacity_weight_kg >= 0),
  capacity_volume_cbm REAL NOT NULL DEFAULT 0 CHECK (capacity_volume_cbm >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, plate_number)
);
CREATE INDEX idx_carrier_vehicles_carrier ON carrier_vehicles(carrier_id, status);

-- 权限：承运商管理已涵盖司机车辆维护，复用 carrier.manage 权限
