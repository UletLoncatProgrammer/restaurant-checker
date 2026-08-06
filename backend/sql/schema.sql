-- Restaurant Checker — data model v1
-- Scope: Order entry -> Kitchen Display -> Coordinator dashboard.
-- Columns commented "(future: X module)" exist now to avoid painful
-- migrations later, but no code reads them yet — see ARCHITECTURE.md
-- before assuming inventory/HR/finance work.
--
-- Plain SQL, run via a small Node script (src/migrate.js) rather than an
-- ORM migration tool — deliberate choice: this needs to run on a machine
-- on the restaurant's LAN that may not have reliable internet, and
-- ORM tooling that fetches native binaries from the internet at
-- install/generate time is a bad fit for that environment. Verified this
-- the hard way while building — see README for the note.

DO $$ BEGIN
  CREATE TYPE role AS ENUM ('ADMIN', 'COORDINATOR', 'FOH', 'KITCHEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_item_status AS ENUM ('PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The restaurant business. One organization can own multiple locations.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One physical restaurant branch. Every operational record hangs off a
-- location so multi-location data is isolated from day one instead of
-- retrofitted later.
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta', -- required for correct multi-location reporting later
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_locations_org ON locations(organization_id);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  label TEXT NOT NULL, -- e.g. "Table 4", "Bar 2"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_location ON restaurant_tables(location_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role role NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- (future: HR module) pay rate, shift schedule, time clock entries are
  -- deliberately NOT modeled here — separate module, separate data-privacy
  -- and labor-law scope this release doesn't need.
);
CREATE INDEX IF NOT EXISTS idx_users_location ON users(location_id);

CREATE TABLE IF NOT EXISTS menu_categories (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_menu_categories_location ON menu_categories(location_id);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  category_id TEXT REFERENCES menu_categories(id),
  name TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  tax_rate NUMERIC(5, 4) NOT NULL DEFAULT 0, -- e.g. 0.10 = 10% — (future: finance/tax module)
  station TEXT NOT NULL DEFAULT 'main', -- kitchen station routing — single-station assumed in v1
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- (future: inventory module) recipe/ingredient mapping is not modeled
  -- here — needs real recipe data from the business, not invented.
);
CREATE INDEX IF NOT EXISTS idx_menu_items_location ON menu_items(location_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  table_id TEXT NOT NULL REFERENCES restaurant_tables(id),
  status order_status NOT NULL DEFAULT 'OPEN',
  opened_by_id TEXT NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_location_status ON orders(location_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price NUMERIC(10, 2) NOT NULL, -- captured at order time — prices change, history must not
  tax_rate NUMERIC(5, 4) NOT NULL DEFAULT 0, -- captured at order time, same reason
  notes TEXT,
  status order_item_status NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_menu_status ON order_items(menu_item_id, status);
