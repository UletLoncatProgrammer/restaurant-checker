#!/usr/bin/env bash
# Offboards a company: final backup, stops and deletes its containers and database volume,
# removes its web address. The final dump is kept in $RC_HOME/archive/.
#   deploy/remove-company.sh <slug>
. "$(dirname "$0")/lib.sh"
SLUG="${1:-}"; [ -n "$SLUG" ] || die "Usage: remove-company.sh <slug>"
require_company "$SLUG"; load_conf
echo "This permanently removes company '$SLUG' ($(env_get "$SLUG" COMPANY_NAME)) from this server."
read -r -p "Type the slug to continue: " A1; [ "$A1" = "$SLUG" ] || die "Cancelled."
read -r -p "Type it again to confirm: " A2; [ "$A2" = "$SLUG" ] || die "Cancelled."
"$DEPLOY_DIR/backup.sh" "$SLUG" || die "Final backup failed - nothing was removed."
mkdir -p "$RC_HOME/archive"
ARCH="$RC_HOME/archive/$SLUG-$(date +%Y%m%d)"
run mkdir -p "$ARCH"
run cp -a "$RC_HOME/backups/$SLUG/." "$ARCH/"
compose_company "$SLUG" down -v
run rm -f "$RC_HOME/caddy/sites/$SLUG.caddy"
run docker exec rc_caddy caddy reload --config /etc/caddy/Caddyfile || true
run rm -rf "$(company_dir "$SLUG")" "$RC_HOME/backups/$SLUG"
info "Removed. Final backup kept in $ARCH (delete it when your contract/retention period allows)."
