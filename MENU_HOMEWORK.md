# Menu homework — one file per restaurant

Login/staff accounts are deliberately left out of this — see the note at the bottom. This is just: how does a new restaurant's menu get into the system.

## How the menu is actually stored

Not a spreadsheet, not hardcoded in the app's code (that was the old, wrong way — see below) — it lives in the database, in two tables: `menu_categories` (e.g. "Mains", "Drinks") and `menu_items` (each dish/drink, with its price and tax rate, linked to a category and to one restaurant branch via `location_id`). Every branch's menu is completely separate — Branch A can never see or accidentally edit Branch B's prices.

**What changed just now:** before this, the only way menu data got into those tables was a hardcoded list buried in `backend/src/seed.js` — meaning "add a new restaurant's menu" meant editing JavaScript. That's fixed. Now each restaurant gets one JSON file (`backend/menus/<name>.json`), and a script (`node src/import-menu.js menus/<name>.json`) reads that file and loads it into the database. Edit the file, re-run the same command, and it updates prices / adds new items — it won't create duplicates if you run it more than once (verified: ran it twice on the same file, still exactly one location and the expected item count both times).

## The homework: fill this in per restaurant

Copy `backend/menus/application-example.json` to a new file (e.g. `backend/menus/my-restaurant.json`) and fill in:

```json
{
  "organization": "<the business name, shared across all its branches>",
  "location": {
    "name": "<this specific branch's name>",
    "timezone": "Asia/Jakarta"
  },
  "tables": ["Table 1", "Table 2", "..."],
  "categories": [
    {
      "name": "<category name, e.g. Mains>",
      "sortOrder": 1,
      "items": [
        { "name": "<dish name>", "price": 45000, "taxRate": 0.10 }
      ]
    }
  ]
}
```

Questions to answer before filling it in:

1. **Organization name** — if this restaurant has multiple branches, they all share one `organization` name (that's what groups them together) but each branch gets its own `location.name`.
2. **Tables** — list every physical table/seat/bar-stool as it should appear on the order-entry screen. Just labels, e.g. "Table 1", "Bar 3", "Patio 2" — order doesn't matter.
3. **Categories** — how the menu should be grouped on the order-entry screen (Mains, Drinks, Appetizers, whatever matches how staff actually think about the menu — doesn't have to match a printed menu's exact wording).
4. **Each item** — name, price (plain number, no currency symbol, no thousands separator), and tax rate as a decimal (0.10 = 10%, 0 if not taxed). If tax rate varies by item (some jurisdictions tax alcohol differently, for instance), that's already supported — just set it per item.
5. **Kitchen station** (optional, defaults to "main") — not in the template above because v1 only supports one kitchen display per branch; if a branch has a separate bar station that needs its own screen, flag that before filling this in — it changes the setup.

## What's deliberately not part of this homework

**Staff logins are separate.** This file only creates the organization, branch, tables, and menu — no user accounts. That's intentional, per your request to set login aside for now: it means you (or I) can stand up and test a branch's actual menu structure without deciding anything about who logs in or how yet. Staff accounts get added in a later step, whenever you're ready to tackle that.

## Testing this yourself

```bash
cd backend
node src/import-menu.js menus/application-example.json
```

Then check it landed correctly — either query the database directly, or once a staff login exists for that branch, the Order Entry screen will show exactly these categories and items.
