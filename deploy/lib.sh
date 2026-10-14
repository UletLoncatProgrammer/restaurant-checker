#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Source it; do not run it.
# RC_DRY_RUN=1 prints every docker/caddy command instead of running it (used by the tests).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
RC_HOME="${RC_HOME:-/srv/rc}"
RC_DRY_RUN="${RC_DRY_RUN:-0}"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# Runs a command, or just prints it in dry-run mode.
run() {
  if [ "$RC_DRY_RUN" = "1" ]; then echo "[dry-run] $*"; else "$@"; fi
}

load_conf() {
  local conf="$RC_HOME/rc.conf"
  [ -f "$conf" ] || die "$conf not found. Create it with RC_DOMAIN=yourdomain.com and ACME_EMAIL=you@yourdomain.com (see deploy/README.md)."
  # shellcheck disable=SC1090
  set -a; . "$conf"; set +a
  [ -n "${RC_DOMAIN:-}" ] || die "RC_DOMAIN is not set in $conf"
  [ -n "${ACME_EMAIL:-}" ] || die "ACME_EMAIL is not set in $conf"
}

valid_slug() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])$ ]]; }
company_dir() { echo "$RC_HOME/companies/$1"; }
require_company() {
  valid_slug "$1" || die "Bad company slug '$1' (lowercase letters, digits and dashes, 2-30 chars)"
  [ -d "$(company_dir "$1")" ] || die "No such company: $1"
}

# docker compose for one company: compose_company <slug> <args...>
compose_company() {
  local slug="$1"; shift
  run docker compose -p "rc_${slug}" --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.company.yml" \
    --env-file "$(company_dir "$slug")/.env" "$@"
}

# Waits until a container reports healthy (or fails after $2 seconds).
wait_healthy() {
  local name="$1" secs="${2:-120}" i=0 st
  [ "$RC_DRY_RUN" = "1" ] && { echo "[dry-run] wait until $name is healthy"; return 0; }
  while [ $i -lt "$secs" ]; do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    [ "$st" = "healthy" ] && return 0
    sleep 2; i=$((i+2))
  done
  return 1
}

list_slugs() { [ -d "$RC_HOME/companies" ] && ls -1 "$RC_HOME/companies" 2>/dev/null || true; }

env_get() { { grep -E "^$2=" "$(company_dir "$1")/.env" || true; } | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
env_set() { # env_set <slug> <KEY> <value>
  local f; f="$(company_dir "$1")/.env"
  if grep -qE "^$2=" "$f"; then sed -i "s|^$2=.*|$2=$3|" "$f"; else echo "$2=$3" >> "$f"; fi
}
