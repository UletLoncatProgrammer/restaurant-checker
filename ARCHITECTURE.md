# Restaurant Checker — Architecture & Roadmap

## Scope of this build

This build covers **order entry → kitchen display → coordinator visibility**, plus (v2) **waiter POS / payments, supervisor voids, a transactions + activity view, per-item stock, sound alerts, and an Excel sales+stock report**. Ingredient-level inventory, purchasing, full finance/tax filing, and HR are **not built** in this pass — the data model is shaped so those modules can be added without reworking the core schema, but the modules themselves are future work. Do not read "future-proofed" as "already supports."

## Decisions and why

**Multi-tenant from day one.** You confirmed multiple locations now or soon. The schema uses `Organization → Location → Table/User/Order` from the start. Retrofitting multi-location isolation onto a single-tenant schema later means a data migration on live order data — expensive and risky mid-service. Building it now costs more upfront (auth and every query must be location-scoped) but is the right call given your stated trajectory.

**Cloud (VPS), one stack per company - decision changed for the commercial version.** Originally this was designed local-network-first, so a restaurant's internet outage would not stop orders. For selling the product, the owner chose a cloud-only v1: every customer company runs as its own isolated stack (own Postgres, app container, secrets) on the operator's VPS, behind one Caddy front door with automatic HTTPS. The trade-off, stated plainly: **a restaurant whose internet drops cannot take or move orders until it returns**, and there is no offline queue. That risk is accepted for v1; the mitigation to build next is an offline queue in the apps or an optional on-site server (not built).

**Tech stack:** Node.js/Express + Socket.IO (real-time order status push) + PostgreSQL via the plain `pg` driver and one idempotent SQL file (`backend/sql/schema.sql`) on the backend (Prisma was dropped: it downloads native binaries at install time, which contradicts the LAN-first goal); React (Vite) on the frontend, browser-based, and wrapped as Android (Capacitor) and Windows (Electron) apps that load the same code. This is a standard, boring stack chosen for maintainability by whoever inherits this code after me — not the most novel option, which is the point.

## Data model (v1 + v2 additions)

```
Organization (the restaurant business, multi-location)
  └─ Location (each physical restaurant)
       ├─ Table (dine-in tables, for order/table mapping)
       ├─ User (staff: role = FOH | KITCHEN | COORDINATOR | SUPERVISOR | ADMIN, scoped to Location)
       ├─ MenuCategory → MenuItem (name, price, tax_rate, active flag)
       └─ Order (table_id, status, opened_by, opened_at, closed_at)
            ├─ OrderItem (menu_item_id, quantity, status: PENDING → PREPARING → READY → DELIVERED, or CANCELLED via supervisor void; void reason/who/when)
            └─ Payment (one per order, UNIQUE; subtotal/tax/total computed in SQL; method; PAID | VOIDED)
       ├─ OrderEvent (append-only activity log: orders, status changes, payments, voids, stock changes)
       └─ StockMovement (signed ledger per tracked MenuItem; on-hand = SUM(delta))
```

**Money rules (v2).** Prices are treated as **tax-exclusive**; tax is `ROUND(qty × unit_price × tax_rate, 0)` per line (whole rupiah). Totals are computed server-side in SQL from the prices frozen on each order item — the client never sends an amount to charge. Currency is assumed IDR; multi-currency is not supported. A DB `CHECK` enforces `total = subtotal + tax`, and `UNIQUE(order_id)` makes a second payment on the same order impossible.

Fields deliberately included now to avoid painful later migrations, even though nothing reads them yet:
- `MenuItem.tax_rate` and `OrderItem.unit_price` (captured at order time, not looked up later) — needed for finance/tax module, and prices/tax rates change over time so historical orders must freeze the value used.
- `Location.timezone` — required correctly for any multi-location reporting later.
- `User.role` enum built to extend, but HR-specific fields (pay rate, shift schedules) are **not** in this schema — that's HR module scope, deliberately deferred so this release doesn't carry HR data-privacy obligations it doesn't need yet.

Explicitly **not** in v1, and why guessing the shape now would be wrong: `Ingredient`, `Recipe`, `StockLevel` (inventory — needs your actual recipe/yield data, which I don't have and shouldn't invent), `Supplier`, `PurchaseOrder` (purchasing — needs your vendor terms), `Shift`, `TimeClockEntry` (HR — needs your labor law jurisdiction, which varies by location and changes overtime rules). Building these on assumptions would produce a schema you'd have to tear up anyway.

## Order/kitchen flow (what's actually built)

1. FOH staff opens a table on tablet, adds items → `Order` + `OrderItem` rows created, status `PENDING`.
2. Kitchen Display (screen in kitchen) receives the order in real time via WebSocket — replaces the paper ticket on the magnet board.
3. Kitchen marks each item `PREPARING` → `READY` as it's cooked.
4. Coordinator Dashboard (the "someone with full visibility" role you described) shows two views simultaneously: a live board of every open table and its order status, and an aggregated view — "12x Nasi Goreng ordered, 4 delivered, 8 outstanding" — computed live from `OrderItem` status, not a separate counter to keep in sync.
5. FOH marks items `DELIVERED` when brought to table.
6. (v2) Once everything is delivered, the waiter charges the table in the **POS** (cash / card / QRIS / other). Payment and table-close happen in one transaction; a receipt can be printed.
7. (v2) A **supervisor** (or admin) can void an item, a whole open order, or an already-paid sale — reason mandatory, logged under their name. Items the kitchen has not started are returned to stock; items already being cooked are treated as waste.

Item status moves are enforced server-side: only the forward steps PENDING→PREPARING→READY (kitchen roles) and READY→DELIVERED (floor roles). The only way to cancel an item is a supervisor void.

**Sockets (v2 security fix).** v1 let any client join any location's room by sending its id. Sockets now present the JWT at connect time and are placed only in their own location (and role) rooms. Payment/audit events go only to coordinator/supervisor/admin sockets.

## Known limitations of this release — read before treating this as done

- **POS records payments; it does not process them.** Cash/card/QRIS are *recorded* by the cashier. There is no card-terminal, QRIS gateway, or e-wallet integration, so the app cannot verify that a card or QRIS payment actually went through. Split bills, tips, discounts, service charge and refunds-to-card are not modeled.
- **Stock is per menu item, not per ingredient.** Only items with stock tracking on (set in the menu JSON via `trackStock`/`openingStock`) are counted. Stock is deducted when the order is *sent*, not when paid. Real ingredient inventory still needs your recipes.
- **Sound alerts need a awake, unlocked page.** A browser cannot ring while the tablet screen is locked or Safari is in the background (see README "Tablet setup for alerts"). The on-screen banner is the fallback, not a replacement.
- **Excel reports reflect data at generation time.** If a sale is voided after a report was downloaded, re-running that day gives different numbers by design.
- **Single physical kitchen assumed per location.** If a location has multiple prep stations (grill vs. bar, say) that need separate displays, that's a small but real schema change (routing on `MenuItem.station`), not yet built.
- **I have not tested this on your actual tablets/hardware.** I've verified it runs and the API/DB layer works in a sandboxed environment. Real-world verification — wifi range in your kitchen, screen size on your actual devices, staff usability under a dinner rush — requires you to pilot it on-site. Don't roll this out to a live service night without a supervised trial shift first.
- **No offline queueing yet.** If the local server itself goes down (not just internet — the actual on-site machine), orders in flight are not queued client-side and replayed. That's a reasonable phase-2 addition if you adopt this; flagging now so it's a known gap, not a surprise.

## Roadmap (matches your stated order: order → inventory → purchasing → finance → HR dashboard)

| Phase | Module | Depends on |
|---|---|---|
| 1 (this build) | Order entry + Kitchen Display + Coordinator dashboard + POS/payments + supervisor voids + stock-per-item + Excel report | — |
| 2 | Inventory management | Recipe data from you (what ingredients per menu item, current stock) |
| 3 | Purchasing | Supplier list, reorder thresholds |
| 4 | Finance/tax | Your jurisdiction's tax rules per location, chart of accounts |
| 5 | HR dashboard (hours worked) | Labor law requirements per location (overtime rules differ by jurisdiction) |

Each phase adds tables and API surface without touching the Order/OrderItem core — SCM (inventory + purchasing) will eventually decrement `StockLevel` when an `OrderItem` is marked `DELIVERED`, but that hook doesn't exist yet because there's no inventory table to hook into.
