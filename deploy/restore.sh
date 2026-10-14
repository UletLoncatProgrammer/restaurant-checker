#!/usr/bin/env bash
# Restores one company from a dump made by backup.sh. DESTROYS that company's current data.
#   deploy/restore.sh <slug> <dumpfile>
. "$(dirname "$0")/lib.sh"
SLUG="${1:-}"; DUMP="${2:-}"
[ -n "$SLUG" ] && [ -f "$DUMP" ] || die "Usage: restore.sh <slug> <dumpfile>"
require_company "$SLUG"; load_conf
echo "This REPLACES all data of '$SLUG' with the contents of $DUMP."
read -r -p "Type the company slug to continue: " ANS
[ "$ANS" = "$SLUG" ] || die "Cancelled."
compose_company "$SLUG" stop app
run docker exec -i "rc_${SLUG}_db" pg_restore -U rc -d rc --clean --if-exists --no-owner < "$DUMP" || echo "(pg_restore warnings above are usual for --clean on objects that did not exist)"
compose_company "$SLUG" start app
wait_healthy "rc_${SLUG}_app" 120 && info "Restored and healthy." || die "App is not healthy after restore - check: docker logs rc_${SLUG}_app"
