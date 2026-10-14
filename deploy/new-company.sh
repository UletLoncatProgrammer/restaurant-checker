#!/usr/bin/env bash
# Creates a brand-new company stack: own database + secrets + HTTPS address + first ADMIN login.
#   deploy/new-company.sh <slug> "<Company Name>" <admin-email> [tables=10] [timezone=Asia/Jakarta] ["Branch name"]
# Example: deploy/new-company.sh acme "Acme Foods" owner@acme.com 20
. "$(dirname "$0")/lib.sh"

SLUG="${1:-}"; NAME="${2:-}"; ADMIN_EMAIL="${3:-}"; TABLES="${4:-10}"; TZ_NAME="${5:-Asia/Jakarta}"; BRANCH="${6:-Main Branch}"
[ -n "$SLUG" ] && [ -n "$NAME" ] && [ -n "$ADMIN_EMAIL" ] || die 'Usage: new-company.sh <slug> "<Company Name>" <admin-email> [tables] [timezone] ["Branch name"]'
valid_slug "$SLUG" || die "Bad slug '$SLUG': lowercase letters, digits and dashes only (2-30 chars), e.g. acme-foods"
[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "Bad admin e-mail"
[[ "$TABLES" =~ ^[0-9]{1,3}$ ]] || die "tables must be a number"
[[ "$NAME" =~ ^[^\"\$\`\\]{2,80}$ ]] || die 'Company name: 2-80 characters, no quotes, $, backticks or backslashes'
[[ "$BRANCH" =~ ^[^\"\$\`\\]{1,60}$ ]] || die 'Branch name: no quotes, $, backticks or backslashes'
load_conf

DIR="$(company_dir "$SLUG")"
[ ! -e "$DIR" ] || die "Company '$SLUG' already exists ($DIR)"
HOST="$SLUG.$RC_DOMAIN"
VERSION="${RC_VERSION:-latest}"

info "Creating company '$NAME' at https://$HOST"
mkdir -p "$DIR" "$RC_HOME/caddy/sites" "$RC_HOME/backups/$SLUG"
umask 077
DBPW="$(openssl rand -hex 24)"; JWT="$(openssl rand -hex 32)"
cat > "$DIR/.env" <<ENVEOF
COMPANY_SLUG=$SLUG
COMPANY_NAME="$NAME"
POSTGRES_PASSWORD=$DBPW
JWT_SECRET=$JWT
# Exact origins allowed to call this company's API: its own web address and the Android/Windows apps.
CORS_ORIGIN=https://$HOST,https://localhost,app://rc
RC_VERSION=$VERSION
ENVEOF
chmod 600 "$DIR/.env"; umask 022

docker image inspect "rc-app:$VERSION" >/dev/null 2>&1 || {
  info "Building image rc-app:$VERSION (first time only, a few minutes)"
  run docker build -f "$DEPLOY_DIR/Dockerfile.app" -t "rc-app:$VERSION" "$REPO_DIR"
}

info "Starting database and app"
compose_company "$SLUG" up -d
wait_healthy "rc_${SLUG}_app" 150 || { compose_company "$SLUG" logs --tail 40 app || true; die "The app did not become healthy. Check the log above. Nothing was exposed to the internet yet."; }

info "Creating the company, branch, tables and first ADMIN"
OUT="$(compose_company "$SLUG" exec -T app node src/provision.js --company "$NAME" --location "$BRANCH" --admin-email "$ADMIN_EMAIL" --tables "$TABLES" --timezone "$TZ_NAME")" || die "Provisioning failed: $OUT"
[ "$RC_DRY_RUN" = "1" ] && OUT="TEMPORARY_PASSWORD=DRYRUNDRYRUN"
TEMP="$(echo "$OUT" | sed -n 's/^TEMPORARY_PASSWORD=//p')"
[ -n "$TEMP" ] || die "Provisioning did not return a temporary password: $OUT"

info "Publishing https://$HOST"
sed -e "s|__HOST__|$HOST|g" -e "s|__UPSTREAM__|rc_${SLUG}_app|g" "$DEPLOY_DIR/company.caddy.template" > "$RC_HOME/caddy/sites/$SLUG.caddy"
run docker exec rc_caddy caddy reload --config /etc/caddy/Caddyfile || echo "WARNING: could not reload Caddy - is the edge stack running? (see deploy/README.md)"
printf '%s\t%s\t%s\t%s\n' "$SLUG" "$NAME" "$HOST" "$(date -u +%FT%TZ)" >> "$RC_HOME/companies.tsv"

cat <<DONE

=====================================================================
 Company ready: $NAME
 Address:        https://$HOST        (DNS: $HOST or *.$RC_DOMAIN must point to this server)
 Company code:   $SLUG               (what staff type in the Android/Windows app)
 First ADMIN:    $ADMIN_EMAIL
 Temporary password (shown ONCE, not stored anywhere): $TEMP
 The ADMIN must choose their own password at first sign-in, then
 create the staff accounts from the Admin screen.
=====================================================================
DONE
