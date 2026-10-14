#!/usr/bin/env bash
# One line per company: address, container health, image version, last backup.
. "$(dirname "$0")/lib.sh"
load_conf
printf '%-20s %-34s %-10s %-9s %s\n' COMPANY ADDRESS APP VERSION LAST_BACKUP
for slug in $(list_slugs); do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "rc_${slug}_app" 2>/dev/null || echo down)"
  last="$(ls -1t "$RC_HOME/backups/$slug"/*.dump 2>/dev/null | head -1 | xargs -r basename || true)"
  printf '%-20s %-34s %-10s %-9s %s\n' "$slug" "$slug.$RC_DOMAIN" "$health" "$(env_get "$slug" RC_VERSION)" "${last:-NONE}"
done
