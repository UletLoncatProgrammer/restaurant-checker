#!/usr/bin/env bash
# Restaurant Checker - on-site mini PC (Ubuntu 22.04/24.04). One tool for everything:
#   sudo bash rc.sh install       first-time setup: engine, settings, build, start, first ADMIN, auto-start, nightly backup
#   sudo ./rc.sh start            (re)start; also refreshes the addresses if the Wi-Fi address changed
#   sudo ./rc.sh stop             stop (data is kept)
#   sudo ./rc.sh status           what is running and where
#   sudo ./rc.sh backup           database copy to /var/backups/restaurant-checker (+ off-site copy if set)
#   sudo ./rc.sh restore [file]   put a backup back (REPLACES current data; newest backup if no file)
#   sudo ./rc.sh update           backup, rebuild from this folder's code, restart
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONSITE="$(dirname "$HERE")"
REPO="$(dirname "$ONSITE")"
COMPOSE_FILE="$ONSITE/compose.yml"
PROJECT=rc_onsite
CONF_DIR=/etc/restaurant-checker
ENV_FILE=$CONF_DIR/settings.env
FIRST_RUN=$CONF_DIR/first-run.env
BACKUP_DIR=/var/backups/restaurant-checker
KEEP_BACKUPS=${KEEP_BACKUPS:-14}
export PODMAN_COMPOSE_WARNING_LOGS=false

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   OK  %s\n' "$*"; }
warn() { printf '   !!  %s\n' "$*" >&2; }
die()  { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run with sudo:  sudo $0 ${1:-}"

# ---------- container engine: Docker if present, otherwise Podman ----------
ENGINE=""; COMPOSE=()
pick_engine() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ENGINE=docker; COMPOSE=(docker compose)
  elif command -v podman >/dev/null 2>&1 && command -v podman-compose >/dev/null 2>&1; then
    ENGINE=podman; COMPOSE=(podman-compose)
  else
    ENGINE=""
  fi
}
install_engine() {
  pick_engine
  if [ -n "$ENGINE" ]; then ok "Using $ENGINE"; return; fi
  say "Installing Podman (container engine) from Ubuntu's own packages"
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y podman podman-compose rsync openssl
  pick_engine
  [ -n "$ENGINE" ] || die "Podman did not install correctly."
  ok "Using $ENGINE"
}
compose() { "${COMPOSE[@]}" -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ---------- settings ----------
get_setting() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$ENV_FILE" 2>/dev/null | head -n1 || true; }
write_settings() {   # $1 db password, $2 jwt, $3 company, $4 sites (space separated), $5 off-site target
  local cors; cors="$(echo "$4" | tr ' ' ',')"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Restaurant Checker (mini PC) settings. Keep private.
POSTGRES_PASSWORD="$1"
JWT_SECRET="$2"
COMPANY_NAME="$3"
RC_SITES="$4"
CORS_ORIGIN="$cors"
# Optional off-site backup target for rsync, e.g. backup@100.101.102.103:/srv/backups/my-restaurant/
RC_OFFSITE="${5:-}"
EOF
  chmod 600 "$ENV_FILE"; umask 022
}

lan_ip() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1 || true)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  echo "$ip"
}
tailscale_ip() { { command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | grep -E '^100\.' | head -n1; } || true; }

compute_sites() {   # sets LAN_IP, TS_IP, SITES
  local i
  LAN_IP="$(lan_ip)"
  # after a power cut the router often starts slower than this PC: wait up to a minute for an address
  for i in $(seq 1 20); do [ -n "$LAN_IP" ] && break; sleep 3; LAN_IP="$(lan_ip)"; done
  TS_IP="$(tailscale_ip)"
  SITES=""
  [ -n "$LAN_IP" ] && SITES="https://$LAN_IP"
  [ -n "$TS_IP" ] && SITES="$SITES https://$TS_IP"
  SITES="$(echo "$SITES https://localhost" | sed 's/^ *//')"
  return 0
}
refresh_sites() {
  compute_sites
  write_settings "$(get_setting POSTGRES_PASSWORD)" "$(get_setting JWT_SECRET)" "$(get_setting COMPANY_NAME)" "$SITES" "$(get_setting RC_OFFSITE)"
}

ask() {   # ask "question" default min max  -> echoes the answer
  local a
  while true; do
    if [ -n "$2" ]; then read -r -p "$1 [$2]: " a; else read -r -p "$1: " a; fi
    a="${a:-$2}"
    if [ "${#a}" -lt "$3" ] || [ "${#a}" -gt "$4" ]; then echo "   Please use $3 to $4 characters." >&2; continue; fi
    case "$a" in *[\"\$\\\`]*) echo '   Please do not use quotes, $, \ or backtick.' >&2; continue;; esac
    echo "$a"; return
  done
}

# Friendly answers -> full time-zone names ("Jakarta" -> "Asia/Jakarta")
normalize_tz() {
  case "$(echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/^ *//; s/ *$//')" in
    jakarta|wib|jkt) echo Asia/Jakarta ;;
    makassar|wita|bali|denpasar) echo Asia/Makassar ;;
    jayapura|wit|papua) echo Asia/Jayapura ;;
    singapore) echo Asia/Singapore ;;
    "kuala lumpur"|kl) echo Asia/Kuala_Lumpur ;;
    *) echo "$1" ;;
  esac
}
valid_tz() { [[ "$1" =~ ^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$ ]] && [ -e "/usr/share/zoneinfo/$1" -o ! -d /usr/share/zoneinfo ]; }
ask_tz() {
  local t
  while true; do
    t="$(normalize_tz "$(ask 'Time zone (Jakarta, Makassar, Jayapura, or e.g. Asia/Jakarta)' 'Asia/Jakarta' 2 60)")"
    valid_tz "$t" && { echo "$t"; return; }
    echo "   Please type Jakarta, Makassar, Jayapura, or a full name such as Asia/Jakarta." >&2
  done
}

build_images() {
  say "Building the app (first time 10-20 minutes and needs internet)"
  "$ENGINE" build -t localhost/rc-onsite-app:latest -f "$REPO/deploy/Dockerfile.app" "$REPO" || return 1
  "$ENGINE" build -t localhost/rc-onsite-caddy:latest "$ONSITE/caddy" || return 1
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    "$ENGINE" exec rc_onsite_app wget -q -O /dev/null http://127.0.0.1:4000/health/ready 2>/dev/null && return 0
    sleep 3
  done
  return 1
}

start_stack() {
  refresh_sites
  # down + up (volumes are kept) works the same on Docker and podman-compose and picks up a changed address
  compose down >/dev/null 2>&1 || true
  compose up -d || die "Starting failed. If a port (80/443) is in use, stop the other web server on this machine."
  wait_ready || { "$ENGINE" logs --tail 30 rc_onsite_app || true; die "The app did not become ready within 3 minutes (log above)."; }
  ok "Running"
}

export_cert() {
  local i
  for i in $(seq 1 15); do
    if "$ENGINE" cp rc_onsite_caddy:/data/caddy/pki/authorities/local/root.crt "$CONF_DIR/rc-root.crt" 2>/dev/null; then
      chmod 644 "$CONF_DIR/rc-root.crt"; return 0
    fi
    sleep 2
  done
  return 1
}

summary() {
  echo
  echo "   =========================================================="
  echo "    Restaurant Checker is running on this mini PC."
  [ -n "${LAN_IP:-}" ] && { echo "    Tablets (same Wi-Fi):"; echo "      1. Open  http://$LAN_IP/rc-root.crt  and install it (once)"; echo "      2. Open  https://$LAN_IP"; }
  [ -n "${TS_IP:-}" ] && echo "    Remote over Tailscale: https://$TS_IP (the device must trust rc-root.crt too)"
  echo "    Settings: $ENV_FILE   Backups: $BACKUP_DIR"
  echo "    Tip: give this mini PC a fixed address in the router (DHCP reservation)."
  echo "   =========================================================="
}

# ---------- commands ----------
cmd_install() {
  . /etc/os-release 2>/dev/null || true
  [ "${ID:-}" = ubuntu ] || warn "This was written for Ubuntu; you are on ${PRETTY_NAME:-an unknown system}. Continuing."
  chmod +x "$HERE/rc.sh"   # copies from Windows can lose the "executable" mark; systemd needs it
  install_engine
  command -v rsync >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y rsync
  mkdir -p "$CONF_DIR" "$BACKUP_DIR"; chmod 700 "$CONF_DIR" "$BACKUP_DIR"

  if [ ! -s "$ENV_FILE" ]; then
    say "First setup: a few questions about the restaurant"
    local company branch email tables tz
    company="$(ask 'Restaurant / company name' '' 2 80)"
    branch="$(ask 'Branch name' 'Main Branch' 1 60)"
    while true; do
      read -r -p "Admin e-mail (only used to sign in, nothing is sent): " email
      email="$(echo "$email" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
      case "$email" in *[\"\$\\\`]*) email="";; esac
      [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] && break
      echo "   That does not look like an e-mail address."
    done
    while true; do
      read -r -p "Number of tables [10]: " tables; tables="${tables:-10}"
      [[ "$tables" =~ ^[0-9]{1,3}$ ]] && [ "$tables" -le 200 ] && break
      echo "   Please type a number from 0 to 200."
    done
    tz="$(ask_tz)"
    write_settings "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" "$company" "https://localhost" ""
    umask 077
    printf 'FR_COMPANY=%q\nFR_BRANCH=%q\nFR_EMAIL=%q\nFR_TABLES=%q\nFR_TZ=%q\n' "$company" "$branch" "$email" "$tables" "$tz" > "$FIRST_RUN"
    umask 022
  fi

  build_images || die "The app could not be built. The first build needs internet; check it and run install again."
  start_stack

  if [ -f "$FIRST_RUN" ]; then
    say "Creating the restaurant and the first admin account"
    # shellcheck disable=SC1090
    . "$FIRST_RUN"
    FR_TZ="$(normalize_tz "$FR_TZ")"; valid_tz "$FR_TZ" || { echo "   The saved time zone is not valid."; FR_TZ="$(ask_tz)"; }
    local out
    if out="$("$ENGINE" exec rc_onsite_app node src/provision.js --company "$FR_COMPANY" --location "$FR_BRANCH" \
          --admin-email "$FR_EMAIL" --admin-name Owner --tables "$FR_TABLES" --timezone "$FR_TZ" 2>&1)"; then
      rm -f "$FIRST_RUN"
      echo
      echo "   =========================================================="
      echo "    First admin sign-in:  $FR_EMAIL"
      echo "    Temporary password:   $(echo "$out" | sed -n 's/^TEMPORARY_PASSWORD=//p')"
      echo "    (shown once; you must choose your own password at first sign-in)"
      echo "   =========================================================="
    elif echo "$out" | grep -q 'already has a company'; then
      rm -f "$FIRST_RUN"; ok "The restaurant was already created earlier."
    else
      echo "$out"; die "Creating the restaurant failed (message above). Your answers are kept; run install again."
    fi
  fi

  say "Auto-start at boot and nightly backup"
  cat > /etc/systemd/system/restaurant-checker.service <<EOF
[Unit]
Description=Restaurant Checker (on-site)
Wants=network-online.target
After=network-online.target $( [ "$ENGINE" = docker ] && echo docker.service )

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart="$HERE/rc.sh" start
ExecStop="$HERE/rc.sh" stop
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable restaurant-checker.service >/dev/null
  ok "Starts by itself when the mini PC powers on"
  cat > /etc/cron.d/restaurant-checker <<EOF
# Nightly database backup at 02:30
30 2 * * * root "$HERE/rc.sh" backup >> /var/log/restaurant-checker-backup.log 2>&1
# Follow a changed Wi-Fi address (and Tailscale coming up) within 5 minutes
*/5 * * * * root "$HERE/rc.sh" refresh >> /var/log/restaurant-checker-refresh.log 2>&1
EOF
  chmod 644 /etc/cron.d/restaurant-checker
  ok "Backup every night at 02:30 (log: /var/log/restaurant-checker-backup.log)"

  export_cert && ok "Certificate for tablets: $CONF_DIR/rc-root.crt (also at http://<this PC>/rc-root.crt)" || warn "Certificate not copied yet; tablets can still download it."
  summary
}

cmd_start()  { pick_engine; [ -n "$ENGINE" ] || die "Not installed yet: sudo $0 install"; [ -s "$ENV_FILE" ] || die "Not installed yet: sudo $0 install"; start_stack; export_cert || true; summary; }
# Every 5 minutes: if the Wi-Fi address changed (or Tailscale came up), restart with the new address.
cmd_refresh() {
  pick_engine; [ -n "$ENGINE" ] && [ -s "$ENV_FILE" ] || exit 0
  compute_sites
  [ "$SITES" = "$(get_setting RC_SITES)" ] && exit 0
  echo "$(date '+%F %T') address changed: '$(get_setting RC_SITES)' -> '$SITES'"
  start_stack
}
cmd_stop()   { pick_engine; [ -n "$ENGINE" ] || exit 0; compose stop || true; ok "Stopped (data kept)"; }
cmd_status() {
  pick_engine; [ -n "$ENGINE" ] || die "Not installed yet."
  "$ENGINE" ps --filter name=rc_onsite --format '{{.Names}}  {{.Status}}' || true
  echo "Addresses: $(get_setting RC_SITES)"
}

cmd_backup() {
  pick_engine; [ -n "$ENGINE" ] || die "Not installed yet."
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  local f="$BACKUP_DIR/rc-$(date +%Y%m%d-%H%M%S).dump"
  "$ENGINE" exec rc_onsite_db pg_dump -U rc -d rc -Fc -f /tmp/rc-backup.dump || die "Backup failed: is it running?"
  "$ENGINE" cp rc_onsite_db:/tmp/rc-backup.dump "$f"
  "$ENGINE" exec rc_onsite_db rm -f /tmp/rc-backup.dump || true
  chmod 600 "$f"
  ok "Saved $f ($(du -h "$f" | cut -f1))"
  { ls -1t "$BACKUP_DIR"/rc-*.dump 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f; } || true
  local off; off="$(get_setting RC_OFFSITE)"
  if [ -n "$off" ]; then
    if rsync -a "$BACKUP_DIR/" "$off"; then ok "Copied off-site to $off"
    else warn "Off-site copy to $off FAILED (no internet?). The local copy is fine; it will be sent next time."; return 1; fi
  else
    warn "No off-site copy configured (RC_OFFSITE in $ENV_FILE). A backup on this PC does not survive theft or fire."
  fi
}

cmd_restore() {
  pick_engine; [ -n "$ENGINE" ] || die "Not installed yet."
  local f="${1:-}"
  [ -n "$f" ] || f="$(ls -1t "$BACKUP_DIR"/rc-*.dump 2>/dev/null | head -n1 || true)"
  [ -n "$f" ] && [ -f "$f" ] || die "No backup file found."
  echo "This REPLACES everything in Restaurant Checker with: $f"
  read -r -p "Type RESTORE to continue: " a; [ "$a" = RESTORE ] || die "Cancelled."
  cmd_backup || true
  compose stop app
  "$ENGINE" cp "$f" rc_onsite_db:/tmp/rc-restore.dump
  local rc=0
  "$ENGINE" exec rc_onsite_db pg_restore --clean --if-exists --no-owner -U rc -d rc /tmp/rc-restore.dump || rc=$?
  "$ENGINE" exec rc_onsite_db rm -f /tmp/rc-restore.dump || true
  compose start app
  [ "$rc" = 0 ] && ok "Restored." || warn "pg_restore reported problems (above). Check the app before using it."
  wait_ready && ok "The app is running again." || warn "The app is slow to come back; check in a minute."
}

cmd_update() {
  pick_engine; [ -n "$ENGINE" ] || die "Not installed yet."
  cmd_backup || warn "Continuing without off-site copy."
  build_images || die "Build failed; the running version was not touched."
  start_stack; summary
}

case "${1:-}" in
  install) cmd_install ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  refresh) cmd_refresh ;;
  backup)  cmd_backup ;;
  restore) shift; cmd_restore "${1:-}" ;;
  update)  cmd_update ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
