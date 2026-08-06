# How Restaurant Checker Works — v1

This explains what was actually built for order entry → kitchen → coordinator, using a concrete walkthrough. Every step described here was tested against the running app, not just written and assumed — see the "verified" notes.

## The three screens

One web app, three different views depending on who logs in. Same login page, same URL — the app decides what to show based on the staff member's role.

| Screen | Who uses it | What it's for |
|---|---|---|
| **Order Entry** | Front-of-house / waitstaff (role: FOH) | Take orders at the table, send them to the kitchen, and mark food delivered once carried out |
| **Kitchen Display** | Kitchen staff (role: KITCHEN) | See incoming orders live, replaces the paper ticket on the magnet board, mark items as being cooked / ready |
| **Coordinator Dashboard** | Whoever has full visibility (role: COORDINATOR) | See every open table at once, plus a live count of what's been ordered but not yet delivered, across the whole floor |

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

**6. Table closes.**
Once every item on Table 3's order is DELIVERED, a "Close table" button appears on both the Order Entry screen and the Coordinator Dashboard. Either the waiter or the coordinator can close it, which archives the order (it stops showing as "open" everywhere, but the record isn't deleted).

## How the "instant" part actually works

Every screen keeps a live connection open to the server (a WebSocket, via a library called Socket.IO) — think of it less like refreshing a webpage and more like a phone line that stays open, so the server can speak the moment something changes rather than waiting to be asked. When any item's status changes, the server pushes that single update to every connected screen for that restaurant branch, and each screen updates just that one row on the page. Nobody has to hit refresh, and it's not polling the server every few seconds and hoping — it's told immediately. Screens for a *different* restaurant branch never receive these updates, even though they might be talking to the same physical server (this is the multi-location isolation from the architecture doc).

## What each role can and can't do (enforced by the server, not just hidden buttons)

- **FOH**: create orders, mark items delivered, close tables. Cannot edit the menu or add tables.
- **KITCHEN**: mark items preparing/ready. Cannot create orders, cannot mark delivered (that's deliberately not their job — they don't know when food actually reaches the table).
- **COORDINATOR / ADMIN**: everything above, plus manage the menu and tables.

## What this is not (yet)

- No bill/payment screen — closing a table archives the order, it doesn't process payment.
- No offline mode — if the network between a tablet and the server drops mid-order, that order isn't queued and retried automatically.
- No inventory/purchasing/finance/HR — those are later phases per `ARCHITECTURE.md`, and nothing here assumes they exist.

## Try it yourself

`README.md` has the exact commands. Short version: seed the sample data, open the app in two browser tabs, log in as `foh@downtown.example` in one and `kitchen@downtown.example` in the other (both password `password123`), and send an order from one tab — watch it appear on the other without touching refresh.
