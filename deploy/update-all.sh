#!/usr/bin/env bash
# Builds the current code once and moves every company onto it, one at a time.
# Stops at the first company that does not come back healthy, so one bad update never
# takes all customers down. Roll back by setting RC_VERSION in that company's .env to the
# previous tag and running:  docker compose ... up -d app   (or re-run with RC_VERSION=<old>).
#   deploy/update-all.sh [version-tag]      (default: git short hash, else timestamp)
. "$(dirname "$0")/lib.sh"
load_conf
VERSION="${1:-$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
info "Backing up everything first"
"$DEPLOY_DIR/backup.sh" || die "Backup failed - not updating."
info "Building rc-app:$VERSION"
run docker build -f "$DEPLOY_DIR/Dockerfile.app" -t "rc-app:$VERSION" "$REPO_DIR"
for slug in $(list_slugs); do
  prev="$(env_get "$slug" RC_VERSION)"
  info "Updating $slug ($prev -> $VERSION)"
  [ "$RC_DRY_RUN" = "1" ] || env_set "$slug" RC_VERSION "$VERSION"
  compose_company "$slug" up -d app
  if ! wait_healthy "rc_${slug}_app" 150; then
    echo "!! $slug did not become healthy on $VERSION. Rolling it back to $prev." >&2
    [ "$RC_DRY_RUN" = "1" ] || env_set "$slug" RC_VERSION "$prev"
    compose_company "$slug" up -d app
    die "Update stopped at $slug. Companies after it were not touched. Logs: docker logs rc_${slug}_app"
  fi
done
info "All companies are on $VERSION."
