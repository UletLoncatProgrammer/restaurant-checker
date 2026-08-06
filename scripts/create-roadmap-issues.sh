#!/usr/bin/env bash
# Creates the phase 2-5 roadmap from ARCHITECTURE.md as GitHub issues +
# milestones. Requires the GitHub CLI, authenticated, run from inside the
# repo after it's pushed:
#
#   gh auth login
#   ./scripts/create-roadmap-issues.sh
#
# Not run automatically by anything — this is a one-time setup script, not
# part of CI. Re-running it will create duplicate issues, so run it once.
set -euo pipefail

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) not found. Install it first: https://cli.github.com"; exit 1; }

gh milestone create "Phase 2: Inventory management" --description "Ingredient/recipe tracking, stock levels. Blocked on recipe data from the business." 2>/dev/null || true
gh milestone create "Phase 3: Purchasing" --description "Supplier records, purchase orders, reorder thresholds. Blocked on supplier list." 2>/dev/null || true
gh milestone create "Phase 4: Finance/tax" --description "Tax rules per location, chart of accounts, financial reporting. Blocked on jurisdiction tax rules." 2>/dev/null || true
gh milestone create "Phase 5: HR dashboard" --description "Staff hours worked. Blocked on labor law requirements per location." 2>/dev/null || true

gh issue create \
  --title "Design Ingredient/Recipe/StockLevel data model" \
  --body "Needs real recipe data from the business (what ingredients per menu item, current stock, units of measure) before this can be designed — not something to guess. See ARCHITECTURE.md 'Explicitly not in v1'." \
  --milestone "Phase 2: Inventory management" \
  --label "inventory,needs-input"

gh issue create \
  --title "Decrement stock on OrderItem DELIVERED" \
  --body "Once StockLevel exists (depends on the recipe data model issue), hook order fulfillment to decrement ingredient stock." \
  --milestone "Phase 2: Inventory management" \
  --label "inventory"

gh issue create \
  --title "Design Supplier/PurchaseOrder data model" \
  --body "Needs supplier list and reorder thresholds from the business." \
  --milestone "Phase 3: Purchasing" \
  --label "purchasing,needs-input"

gh issue create \
  --title "Tax rule configuration per location" \
  --body "MenuItem.tax_rate and OrderItem.tax_rate are already captured (see schema) but there's no admin UI to set/change them per jurisdiction, and no financial statement generation yet." \
  --milestone "Phase 4: Finance/tax" \
  --label "finance,needs-input"

gh issue create \
  --title "HR: staff hours dashboard" \
  --body "Needs labor law requirements per location (overtime rules differ by jurisdiction) before building shift/time-clock data model. Do not guess jurisdiction rules — confirm per location." \
  --milestone "Phase 5: HR dashboard" \
  --label "hr,needs-input"

echo "Done. Review milestones/issues on GitHub — several are intentionally blocked pending real business data, not implementation work."
