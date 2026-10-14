#!/usr/bin/env bash
# Dumps every company's database (or one: backup.sh <slug>) to $RC_HOME/backups/<slug>/ and deletes
# dumps older than $RETENTION_DAYS (default 14). Exit code is non-zero if ANY company failed,
# so cron/monitoring can alert. Run nightly; copy the folder off the server (see deploy/README.md).
. "$(dirname "$0")/lib.sh"
load_conf
RETENTION_DAYS="${RETENTION_DAYS:-14}"
if [ -n "${1:-}" ]; then SLUGS="$1"; require_company "$1"; else SLUGS="$(list_slugs)"; fi
fail=0
for slug in $SLUGS; do
  out="$RC_HOME/backups/$slug"; mkdir -p "$out"
  file="$out/$slug-$(date +%Y%m%d-%H%M%S).dump"
  info "Backing up $slug"
  if [ "$RC_DRY_RUN" = "1" ]; then echo "[dry-run] pg_dump rc_${slug}_db > $file"; continue; fi
  if docker exec "rc_${slug}_db" pg_dump -U rc -d rc -Fc > "$file.part" 2>"$file.err" \
     && [ -s "$file.part" ] \
     && docker exec -i "rc_${slug}_db" pg_restore --list < "$file.part" >/dev/null 2>&1; then
    mv "$file.part" "$file"; rm -f "$file.err"
    find "$out" -name '*.dump' -mtime +"$RETENTION_DAYS" -delete
    echo "    ok: $file ($(du -h "$file" | cut -f1))"
  else
    echo "    FAILED for $slug - see $file.err" >&2; rm -f "$file.part"; fail=1
  fi
done
exit $fail
