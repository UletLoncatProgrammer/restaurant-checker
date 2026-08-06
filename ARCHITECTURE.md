# Restaurant Checker — Architecture & Roadmap

## Scope of this build

This first release covers **order entry → kitchen display → coordinator visibility** only. Inventory, purchasing, finance/tax, and HR are **not built** in this pass — the data model is shaped so those modules can be added without reworking the core schema, but the modules themselves are future work. Do not read "future-proofed" as "already supports."

## Decisions and why

**Multi-tenant from day one.** You confirmed multiple locations now or soon. The schema uses `Organization → Location → Table/User/Order` from the start. Retrofitting multi-location isolation onto a single-tenant schema later means a data migration on live order data — expensive and risky mid-service. Building it now costs more upfront (auth and every query must be location-scoped) but is the right call given your stated trajectory.

**Local-network-first, not cloud-only.** This is the one place I'm overriding the "not decided yet"-style default toward cloud. Your coordinator dashboard and kitchen display are safety-critical to service — if they go down mid-rush, tickets stop moving and nobody has a paper backup anymore. A pure cloud-hosted app means a restaurant's ISP outage (common, not rare) takes down order flow entirely, which is a *regression* from paper tickets on a magnet board that work with zero internet. I'm building this as a self-hosted app: a small server (Docker container, can run on a $150 mini PC on-site or a low-cost VPS per location) on the restaurant's LAN, with tablets/screens connecting over local wifi. It still supports a cloud option later (e.g., syncing multiple locations to a central org-level reporting DB), but each location's order-to-kitchen loop should not depend on internet uptime. If you want pure cloud instead, say so explicitly — it's simpler to run but I think it's the wrong trade-off for a live floor operation, and I'd want to hear the reasoning before changing it.

**Tech stack:** Node.js/Express + Socket.IO (real-time order status push) + PostgreSQL via Prisma (schema-as-code, versioned migrations) on the backend; React (Vite) on the frontend, browser-based so it runs on any tablet without app-store deployment. This is a standard, boring stack chosen for maintainability by whoever inherits this code after me — not the most novel option, which is the point.

## Data model (v1)

```
Organization (the restaurant business, multi-location)
  └─ Location (each physical restaurant)
       ├─ Table (dine-in tables, for order/table mapping)
       ├─ User (staff: role = FOH | KITCHEN | COORDINATOR | ADMIN, scoped to Location)
       ├─ MenuCategory → MenuItem (name, price, tax_rate, active flag)
       └─ Order (table_id, status, opened_by, opened_at, closed_at)
            └─ OrderItem (menu_item_id, quantity, status: PENDING → PREPARING → READY → DELIVERED, notes)
```

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

## Known limitations of this release — read before treating this as done

- **No payment/POS integration.** Orders don't close out a bill or take payment. If you need that before finance/tax module, say so — it changes priority order.
- **Single physical kitchen assumed per location.** If a location has multiple prep stations (grill vs. bar, say) that need separate displays, that's a small but real schema change (routing on `MenuItem.station`), not yet built.
- **I have not tested this on your actual tablets/hardware.** I've verified it runs and the API/DB layer works in a sandboxed environment. Real-world verification — wifi range in your kitchen, screen size on your actual devices, staff usability under a dinner rush — requires you to pilot it on-site. Don't roll this out to a live service night without a supervised trial shift first.
- **No offline queueing yet.** If the local server itself goes down (not just internet — the actual on-site machine), orders in flight are not queued client-side and replayed. That's a reasonable phase-2 addition if you adopt this; flagging now so it's a known gap, not a surprise.

## Roadmap (matches your stated order: order → inventory → purchasing → finance → HR dashboard)

| Phase | Module | Depends on |
|---|---|---|
| 1 (this build) | Order entry + Kitchen Display + Coordinator dashboard | — |
| 2 | Inventory management | Recipe data from you (what ingredients per menu item, current stock) |
| 3 | Purchasing | Supplier list, reorder thresholds |
| 4 | Finance/tax | Your jurisdiction's tax rules per location, chart of accounts |
| 5 | HR dashboard (hours worked) | Labor law requirements per location (overtime rules differ by jurisdiction) |

Each phase adds tables and API surface without touching the Order/OrderItem core — SCM (inventory + purchasing) will eventually decrement `StockLevel` when an `OrderItem` is marked `DELIVERED`, but that hook doesn't exist yet because there's no inventory table to hook into.
