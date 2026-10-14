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

-- ===========================================================================
-- v2: POS payments, supervisor voids, activity log, per-item stock.
-- Everything below is additive/idempotent so an existing v1 database
-- upgrades in place with `npm run migrate` (tested: test/migrate.test.js).
-- ===========================================================================

-- Supervisor: the only floor role (besides ADMIN) allowed to void.
ALTER TYPE role ADD VALUE IF NOT EXISTS 'SUPERVISOR';

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('CASH', 'CARD', 'QRIS', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('PAID', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Per-menu-item stock tracking (units of the menu item itself, e.g. bottles
-- of water). Ingredient-level inventory needs recipes and is NOT modeled.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS voided_by_id TEXT REFERENCES users(id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_by_id TEXT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS void_reason TEXT;

DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One payment per order (UNIQUE) => a double-tapped "Pay" cannot charge twice.
-- Totals are computed server-side in SQL from frozen order_items prices, never
-- accepted from the client. Prices are treated as tax-EXCLUSIVE; tax is
-- rounded per line to whole currency units (IDR has no minor unit in use).
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  receipt_no BIGSERIAL NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  subtotal NUMERIC(12, 2) NOT NULL,
  tax NUMERIC(12, 2) NOT NULL,
  total NUMERIC(12, 2) NOT NULL,
  method payment_method NOT NULL,
  amount_tendered NUMERIC(12, 2),
  change_given NUMERIC(12, 2),
  status payment_status NOT NULL DEFAULT 'PAID',
  paid_by_id TEXT NOT NULL REFERENCES users(id),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_id TEXT REFERENCES users(id),
  void_reason TEXT,
  CONSTRAINT payments_total_matches CHECK (total = subtotal + tax)
);
CREATE INDEX IF NOT EXISTS idx_payments_location_paid ON payments(location_id, paid_at);

-- Append-only activity log: what the coordinator's "all transactions" feed
-- and the void audit trail read from.
CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  order_id TEXT REFERENCES orders(id),
  type TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  message TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_location_time ON order_events(location_id, created_at DESC);

-- Signed ledger: on-hand = SUM(delta). Never UPDATE a quantity in place.
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('OPENING', 'RECEIVE', 'SALE', 'VOID_RESTOCK', 'ADJUST')),
  order_item_id TEXT REFERENCES order_items(id),
  note TEXT,
  user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(menu_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_location_time ON stock_movements(location_id, created_at);

-- ===========================================================================
-- v3: commercial hardening (additive/idempotent, upgrades v1/v2 databases in place).
--   * staff accounts: forced password change, token versioning (revokes old logins),
--     failed-login lockout counters, last login
--   * case-insensitive unique e-mail
--   * tables can be deactivated instead of deleted (history keeps pointing at them)
--   * money/ratio sanity CHECKs and "same location" integrity triggers, so even a
--     buggy query can never mix one branch's rows with another's
--   * auth_events: who signed in / failed / changed passwords / managed staff
-- ===========================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Existing mixed-case duplicates would block this index; the migration keeps going
-- (and says so) rather than failing the whole upgrade.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON users (lower(email));
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'users_email_lower_uniq not created: duplicate e-mails differing only by case exist - fix them, then re-run migrate';
END $$;

ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_label_uniq ON restaurant_tables (location_id, lower(label)) WHERE active;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'restaurant_tables_label_uniq not created: duplicate active table labels exist in a location';
END $$;

DO $$ BEGIN
  ALTER TABLE menu_items ADD CONSTRAINT menu_items_price_nonneg CHECK (price >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE menu_items ADD CONSTRAINT menu_items_tax_rate_range CHECK (tax_rate >= 0 AND tax_rate <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_price_nonneg CHECK (unit_price >= 0 AND tax_rate >= 0 AND tax_rate <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Same-location integrity: a row may only point at rows of its own location.
CREATE OR REPLACE FUNCTION rc_check_same_location() RETURNS trigger AS $$
DECLARE other TEXT;
BEGIN
  IF TG_TABLE_NAME = 'menu_items' THEN
    -- (nested IF: plpgsql does not short-circuit AND, and NEW has no category_id on other tables)
    IF NEW.category_id IS NOT NULL THEN
      SELECT location_id INTO other FROM menu_categories WHERE id = NEW.category_id;
      IF other IS DISTINCT FROM NEW.location_id THEN RAISE EXCEPTION 'category belongs to another location'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'orders' THEN
    SELECT location_id INTO other FROM restaurant_tables WHERE id = NEW.table_id;
    IF other IS DISTINCT FROM NEW.location_id THEN RAISE EXCEPTION 'table belongs to another location'; END IF;
    SELECT location_id INTO other FROM users WHERE id = NEW.opened_by_id;
    IF other IS DISTINCT FROM NEW.location_id THEN RAISE EXCEPTION 'user belongs to another location'; END IF;
  ELSIF TG_TABLE_NAME = 'order_items' THEN
    SELECT o.location_id INTO other FROM orders o WHERE o.id = NEW.order_id;
    IF other IS DISTINCT FROM (SELECT location_id FROM menu_items WHERE id = NEW.menu_item_id) THEN
      RAISE EXCEPTION 'menu item belongs to another location';
    END IF;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    SELECT location_id INTO other FROM orders WHERE id = NEW.order_id;
    IF other IS DISTINCT FROM NEW.location_id THEN RAISE EXCEPTION 'order belongs to another location'; END IF;
  ELSIF TG_TABLE_NAME = 'stock_movements' THEN
    SELECT location_id INTO other FROM menu_items WHERE id = NEW.menu_item_id;
    IF other IS DISTINCT FROM NEW.location_id THEN RAISE EXCEPTION 'menu item belongs to another location'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS menu_items_same_location ON menu_items;
CREATE TRIGGER menu_items_same_location BEFORE INSERT OR UPDATE OF category_id, location_id ON menu_items
  FOR EACH ROW EXECUTE FUNCTION rc_check_same_location();
DROP TRIGGER IF EXISTS orders_same_location ON orders;
CREATE TRIGGER orders_same_location BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION rc_check_same_location();
DROP TRIGGER IF EXISTS order_items_same_location ON order_items;
CREATE TRIGGER order_items_same_location BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION rc_check_same_location();
DROP TRIGGER IF EXISTS payments_same_location ON payments;
CREATE TRIGGER payments_same_location BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION rc_check_same_location();
DROP TRIGGER IF EXISTS stock_movements_same_location ON stock_movements;
CREATE TRIGGER stock_movements_same_location BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION rc_check_same_location();

CREATE TABLE IF NOT EXISTS auth_events (
  id BIGSERIAL PRIMARY KEY,
  location_id TEXT REFERENCES locations(id),
  user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,            -- LOGIN_OK, LOGIN_FAIL, LOCKED, PASSWORD_CHANGED, PASSWORD_RESET, USER_CREATED, USER_UPDATED
  email TEXT,
  ip TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_events_time ON auth_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id, created_at DESC);

-- ===========================================================================
-- v4: a company can switch off built-in roles it does not use (ADMIN can never be switched off).
-- ===========================================================================
ALTER TABLE locations ADD COLUMN IF NOT EXISTS disabled_roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_admin_role_kept;
ALTER TABLE locations ADD CONSTRAINT locations_admin_role_kept CHECK (NOT ('ADMIN' = ANY(disabled_roles)));

-- ===========================================================================
-- v5: kitchen stations and one open bill per table.
--   * Every dish goes to one station: KITCHEN (hot), COLD (cold kitchen) or BAR.
--     Order lines keep the station they had when ordered, so moving a dish later
--     never moves tickets already in the kitchen.
--   * kitchen_mode: ONE = hot and cold dishes share one screen, SPLIT = separate screens.
--   * A table has at most one OPEN order: a second round is added to the same bill.
-- ===========================================================================
ALTER TABLE locations ADD COLUMN IF NOT EXISTS kitchen_mode TEXT NOT NULL DEFAULT 'ONE';
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_kitchen_mode_valid;
ALTER TABLE locations ADD CONSTRAINT locations_kitchen_mode_valid CHECK (kitchen_mode IN ('ONE', 'SPLIT'));

-- older databases used free text (default 'main'): everything that is not cold or bar is the hot kitchen
UPDATE menu_items SET station = CASE
    WHEN upper(station) IN ('COLD', 'COLD KITCHEN') THEN 'COLD'
    WHEN upper(station) IN ('BAR', 'DRINKS', 'BEVERAGE') THEN 'BAR'
    ELSE 'KITCHEN' END
  WHERE station NOT IN ('KITCHEN', 'COLD', 'BAR');
ALTER TABLE menu_items ALTER COLUMN station SET DEFAULT 'KITCHEN';
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_station_valid;
ALTER TABLE menu_items ADD CONSTRAINT menu_items_station_valid CHECK (station IN ('KITCHEN', 'COLD', 'BAR'));

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS station TEXT;
UPDATE order_items oi SET station = mi.station FROM menu_items mi
  WHERE oi.menu_item_id = mi.id AND oi.station IS NULL;
ALTER TABLE order_items ALTER COLUMN station SET DEFAULT 'KITCHEN';
ALTER TABLE order_items ALTER COLUMN station SET NOT NULL;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_station_valid;
ALTER TABLE order_items ADD CONSTRAINT order_items_station_valid CHECK (station IN ('KITCHEN', 'COLD', 'BAR'));

-- The app already adds a second round to the open order; this index makes the database
-- refuse a second OPEN order for the same table even if two waiters press Send together.
-- An old database that already has two open orders on one table gets the index on the
-- first start after those are paid or voided.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders WHERE status = 'OPEN' GROUP BY table_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_order_per_table ON orders(table_id) WHERE status = 'OPEN';
  END IF;
END $$;
