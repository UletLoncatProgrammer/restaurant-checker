# How Restaurant Checker Works — v2

This explains what was actually built for order entry → kitchen → coordinator, using a concrete walkthrough. The server side (orders, payments, voids, stock, Excel numbers, permissions, sockets) is covered by automated tests that run against a real Postgres; the screens are covered by component tests. None of it has been run on a physical tablet — see the limits in `ARCHITECTURE.md`.

## The screens

One web app, three different views depending on who logs in. Same login page, same URL — the app decides what to show based on the staff member's role.

| Screen | Who uses it | What it's for |
|---|---|---|
| **Order Entry** | Front-of-house / waitstaff (role: FOH) | Take orders at the table, send them to the kitchen, and mark food delivered once carried out |
| **Kitchen Display** | Kitchen staff (role: KITCHEN) | See incoming orders live, replaces the paper ticket on the magnet board, mark items as being cooked / ready |
| **POS** | Waiters / cashier (FOH, and the oversight roles) | Pick a fully-served table, see the bill, take payment, print a receipt |
| **Coordinator Dashboard** | Whoever has full visibility (role: COORDINATOR) | Tabs: **Live** (open tables + outstanding counts), **Transactions** (every payment, by day), **Activity** (feed of everything that happens), **Stock**, **Report** (Excel download) |
| **Supervisor** (same dashboard) | Floor supervisor (role: SUPERVISOR) | Same visibility, plus the only place to **void** an item, an order, or a paid sale |

Logging in as a Coordinator or Admin also lets you see the Order Entry and Kitchen screens — those roles are allowed everywhere. FOH and Kitchen accounts only see their own screen; if a kitchen tablet somehow loads the order-entry page, it gets bounced back automatically. This is enforced by the server, not just hidden in the menu, so it can't be bypassed by typing a different address into the browser.

## Walkthrough: one order, start to finish

Say a customer at **Table 3** orders 2x Nasi Goreng and 1x Es Teh Manis.

**1. Waitstaff takes the order (Order Entry screen).**
The waiter picks "Table 3" from a dropdown, taps "Nasi Goreng" twice and "Es Teh Manis" once — each tap adds one to a running cart shown at the bottom of the screen, with +/− buttons to adjust quantity. They tap "Send to kitchen." *(Verified: this calls the server, which checks the table and every menu item genuinely belong to that restaurant branch before accepting the order — a fake or copy-pasted ID from another location is rejected.)*

**2. The kitchen sees it appear instantly (Kitchen Display screen).**
Without anyone refreshing anything, a new ticket titled "Table 3" appears on the kitchen screen, listing 2x Nasi Goreng and 1x Es Teh Manis, each tagged "PENDING." This is the direct replacement for walking the paper ticket over to the magnet board. *(Verified: creating the order via the API and watching it appear is exactly what I tested — the push is instant because of how step 5 below works.)*

**3. Kitchen cooks and updates status.**
As the cook starts each dish, they tap "Mark PREPARING" on that item. When it's plated and ready to go out, they tap "Mark READY." Each tap updates that one item's status pill (color-coded: yellow = pending, blue = preparing, green = ready). The ticket border itself turns green once every item on it is ready. *(Verified: PENDING → PREPARING → READY transitions were tested directly against the running server.)*

**4. The coordinator watches the whole floor at once (Coordinator Dashboard screen).**
Two live panels, side by side:
- **Open tables** — every table with an order in progress, and how many of its items are delivered vs. total (e.g. "0/3 delivered — In progress").
- **Outstanding by item** — a running count across *all* open tables: "2x Nasi Goreng outstanding, 1x Es Teh Manis outstanding." This is computed fresh from actual item statuses every time, not a separate tally someone has to remember to update, so it can't silently drift from reality.

**5. Waitstaff delivers the food and marks it (Order Entry screen, bottom half).**
This is the step I initially built the server logic for but forgot to put a button on screen for — caught and fixed just now. The waiter's screen shows a live list of their open tables. Once an item shows "READY," a "Mark delivered" button appears next to it; tapping it after physically carrying the dish to the table updates its status to DELIVERED everywhere at once — the kitchen ticket, the coordinator's counts, and the outstanding-items list all update in the same instant. *(Verified: the full chain — READY → DELIVERED → close table → order disappears from every open-orders list — was tested end to end after the fix.)*

**6. Paying and closing (POS screen).**
Once every item on Table 3's order is DELIVERED, a "Pay this table" button appears. The POS shows the bill the *server* calculated (subtotal, tax, total). The waiter picks Cash / Card / QRIS / Other; for cash they type the cash received and the screen shows the change. "Charge" records the payment and closes the table in one step, and a receipt appears (with a Print button). Paying twice is impossible — the second attempt is refused.

**7. Mistakes: voids (Supervisor).**
A wrong dish or a walk-out is handled by a supervisor/admin on the dashboard: "Void" on an item, "Void order" on a table, or "Void sale" on a paid transaction. A written reason is required. The kitchen screen strikes the item through and plays a different sound so the cook stops making it. Everything is logged in the Activity feed with who did it.

**8. Reporting (Coordinator).**
Report tab → choose Daily or Weekly (and optionally a date) → "Download Excel". One file with sheets: Summary, Sales by day, Sales by item, Transactions, Stock, Voids. Days run midnight-to-midnight in the location's timezone; a week is Monday–Sunday.

## How the "instant" part actually works

Every screen keeps a live connection open to the server (a WebSocket, via a library called Socket.IO) — think of it less like refreshing a webpage and more like a phone line that stays open, so the server can speak the moment something changes rather than waiting to be asked. When any item's status changes, the server pushes that single update to every connected screen for that restaurant branch, and each screen updates just that one row on the page. Nobody has to hit refresh, and it's not polling the server every few seconds and hoping — it's told immediately. Screens for a *different* restaurant branch never receive these updates, even though they might be talking to the same physical server (this is the multi-location isolation from the architecture doc).

## Roles and permissions (enforced by the server, not just hidden buttons)

A role is a name plus tick-boxes (permissions): **Orders** (take orders, serve dishes), **Payment** (POS), **Hot kitchen / Cold kitchen / Bar** screens, **Dashboard** (live tables, payments, activity, stock), **History** (kitchen and bar history), **Void**, **Excel** report, **Menu** (menu, tables, kitchen setup) and **Staff & roles** (Admin only).

The five built-in roles are ready-made presets:

- **Waiter (FOH)**: orders and payment.
- **Kitchen / bar**: the hot kitchen, cold kitchen and bar screens.
- **Coordinator**: everything on the floor, dashboard, history, Excel report, menu. Cannot void.
- **Supervisor**: everything on the floor, dashboard, history, and void. No Excel report.
- **Admin**: everything, always.

In **Admin > Roles** an Admin can change the tick-boxes of any role except Admin, create the restaurant's own roles (e.g. "Food runner" = Orders only, "Barista" = Bar screen only), delete own roles nobody holds, and switch off built-in roles the restaurant doesn't use. Changes apply at once: people with that role are reconnected with their new screens. Kitchen-only roles never receive customers' phone numbers.

There is no self-registration. The Admin uses **Admin > Staff** to add people, choose their role, disable them and issue temporary passwords; staff must choose their own password at first sign-in. The first Admin of a company is created when the company is set up (`deploy/new-company.sh` on the VPS, or the on-site installer).

## The bill: member discount, service charge, tax

At payment the bill is worked out by the server, in this order:

1. **Food & drinks** — the prices frozen when each dish was ordered (voided dishes left out).
2. **Member discount** — if the cashier found a member by phone, their discount % comes off the food.
3. **Service charge** — a % of the food after discount (Admin > Billing; new restaurants start at 5%).
4. **Tax** — the restaurant tax (PBJT, printed as e.g. "PB1"), a % of food after discount, plus the service charge
   if "tax on service" is ticked (new restaurants: 10%, ticked). In Indonesia restaurant meals pay PBJT, not VAT;
   it is at most 10% and each city sets its own rate — check yours.

Each part is rounded to whole rupiah. The payment keeps the rates used, so changing them later never changes old
bills. Only Admin can change the rates; the member list is kept by roles with the "Members" tick-box
(Admin, Coordinator and Supervisor by default) and cashiers can only look members up.

## Sound alerts

- **Kitchen** hears a two-note "ding-dong" (twice) when a new order arrives, and a low falling beep when something is voided.
- **Waiters** hear a rising three-note chime when food for **their own** table is READY. Coordinators/supervisors/admins hear it for every table. Everyone also gets a coloured banner on screen.
- The sounds are generated in code. Browsers only allow audio after someone taps the screen once; a red bar says so after a page reload — tap it. "Sound: ON/OFF" in the top bar mutes a device and plays a test chime.

## What this is not (yet)

- No real payment processing — card/QRIS are *recorded* by the cashier; nothing is verified with a bank or gateway. No split bills, tips or discounts.
- No offline mode — version 1 is cloud only. If a restaurant's internet drops, orders cannot be taken or moved until it returns, and nothing is queued and retried automatically.
- No inventory/purchasing/finance/HR — those are later phases per `ARCHITECTURE.md`, and nothing here assumes they exist.

## Try it yourself

`README.md` has the exact commands. Short version: seed the sample data, open the app in two browser tabs, log in as `foh@downtown.example` in one and `kitchen@downtown.example` in the other (both password `password123`), and send an order from one tab — watch it appear on the other without touching refresh.
