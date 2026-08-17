CREATE TABLE logistics_products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  origin_country_code TEXT NOT NULL,
  origin_city TEXT,
  destination_country_code TEXT NOT NULL,
  destination_city TEXT,
  transport_mode TEXT NOT NULL,
  estimated_days TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  charge_weight_mode TEXT NOT NULL DEFAULT 'max_actual_volume' CHECK (charge_weight_mode IN ('max_actual_volume','actual','volume','density')),
  pricing_mode TEXT NOT NULL DEFAULT 'first_additional' CHECK (pricing_mode IN ('first_additional','tier_unit','multi_additional','tier_first_additional','density_tier')),
  min_weight REAL NOT NULL DEFAULT 0 CHECK (min_weight >= 0),
  max_weight REAL CHECK (max_weight IS NULL OR max_weight > 0),
  volume_divisor REAL NOT NULL DEFAULT 5000 CHECK (volume_divisor > 0),
  rounding_unit REAL NOT NULL DEFAULT 0.5 CHECK (rounding_unit > 0),
  density_threshold REAL NOT NULL DEFAULT 250 CHECK (density_threshold > 0),
  density_low_mode TEXT NOT NULL DEFAULT 'volume' CHECK (density_low_mode IN ('actual','volume')),
  density_high_mode TEXT NOT NULL DEFAULT 'actual' CHECK (density_high_mode IN ('actual','volume')),
  first_weight REAL NOT NULL DEFAULT 1 CHECK (first_weight > 0),
  first_price REAL NOT NULL DEFAULT 0 CHECK (first_price >= 0),
  additional_weight REAL NOT NULL DEFAULT 0.5 CHECK (additional_weight > 0),
  additional_price REAL NOT NULL DEFAULT 0 CHECK (additional_price >= 0),
  minimum_charge REAL NOT NULL DEFAULT 0 CHECK (minimum_charge >= 0),
  handling_fee REAL NOT NULL DEFAULT 0 CHECK (handling_fee >= 0),
  fuel_surcharge_rate REAL NOT NULL DEFAULT 0 CHECK (fuel_surcharge_rate >= 0),
  cargo_surcharge_rate REAL NOT NULL DEFAULT 0 CHECK (cargo_surcharge_rate >= 0),
  public_visible INTEGER NOT NULL DEFAULT 0 CHECK (public_visible IN (0,1)),
  effective_from TEXT,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled')),
  remarks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, product_code)
);

CREATE TABLE logistics_product_price_tiers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES logistics_products(id) ON DELETE CASCADE,
  from_value REAL NOT NULL DEFAULT 0 CHECK (from_value >= 0),
  to_value REAL CHECK (to_value IS NULL OR to_value > from_value),
  cargo_class TEXT CHECK (cargo_class IS NULL OR cargo_class IN ('light','heavy')),
  billing_unit TEXT NOT NULL DEFAULT 'KG' CHECK (billing_unit IN ('KG','CBM')),
  unit_size REAL CHECK (unit_size IS NULL OR unit_size > 0),
  unit_price REAL CHECK (unit_price IS NULL OR unit_price >= 0),
  first_weight REAL CHECK (first_weight IS NULL OR first_weight > 0),
  first_price REAL CHECK (first_price IS NULL OR first_price >= 0),
  additional_weight REAL CHECK (additional_weight IS NULL OR additional_weight > 0),
  additional_price REAL CHECK (additional_price IS NULL OR additional_price >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_logistics_products_org_status ON logistics_products(organization_id,status,updated_at);
CREATE INDEX idx_logistics_products_route ON logistics_products(organization_id,origin_country_code,destination_country_code);
CREATE INDEX idx_logistics_product_tiers_product ON logistics_product_price_tiers(product_id,sort_order,from_value);

INSERT INTO permissions(code,module,name,description) VALUES
  ('pricing.view','pricing','查看物流产品','查看物流产品、计费规则和试算结果'),
  ('pricing.manage','pricing','管理物流产品','创建物流产品并维护价格阶梯和附加费');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.module='pricing'
WHERE r.code='owner' AND r.is_system=1;
