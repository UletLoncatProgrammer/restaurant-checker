# Running Restaurant Checker for customers (operator guide)

One VPS, one HTTPS front door (Caddy), and **one isolated stack per customer company**
(own Postgres, own app container, own random secrets, own backup folder).
Staff use the browser version at `https://<company>.<your-domain>` or the Android / Windows
app, which asks for the **company code** once.

> Status, honestly: the backend, the web app, and these scripts' logic were tested on a
> development machine (backend 26 tests, frontend 30 tests, scripts by dry-run and syntax check).
> **The Docker/VPS flow itself has not been run end to end yet.** Do the "first customer" test
> below with a throw-away company before selling anything.

## 1. One-time VPS setup

Assumptions: Ubuntu 22.04/24.04 VPS, a domain you control, root access.

1. DNS: add a wildcard record `*.yourdomain.com` → the VPS IP (and `yourdomain.com` if you want one).
2. Install Docker Engine + compose plugin (docs.docker.com/engine/install/ubuntu).
3. Firewall: allow only 22, 80, 443 (`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`).
   The databases are never published to the internet; keep it that way.
4. Install `fail2ban` and `unattended-upgrades`; use SSH keys only (`PasswordAuthentication no`).
5. Docker log rotation (`/etc/docker/daemon.json`: `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}`), then restart Docker.
6. Put the project on the server (`git clone` or copy) e.g. `/opt/restaurant-checker`.
7. Create the operator config:

   ```
   mkdir -p /srv/rc && cat > /srv/rc/rc.conf <<'CONF'
   RC_DOMAIN=yourdomain.com
   ACME_EMAIL=you@yourdomain.com
   CONF
   chmod 600 /srv/rc/rc.conf
   ```
8. Start the front door (once):

   ```
   docker network create rc_edge
   docker compose -f deploy/docker-compose.edge.yml --env-file /srv/rc/rc.conf up -d
   ```

## 2. Add a customer company (about 2-4 minutes, first build longer)

```
deploy/new-company.sh acme "Acme Foods" owner@acme.com 20 Asia/Jakarta "Main Branch"
```

It builds the image the first time, starts the company's database and app, waits until healthy,
creates the company, branch, tables and the first ADMIN, then publishes `https://acme.yourdomain.com`.
It prints the **company code** (`acme`) and a **temporary password shown once**. Give both to the owner
securely (not in a group chat). The owner signs in, chooses their own password, and creates staff in
the **Admin** screen.

Other commands (all in `deploy/`): `list-companies.sh`, `backup.sh [slug]` (no slug = every company), `restore.sh <slug> <file>`,
`update-all.sh` (backs up everything, rebuilds the image and moves companies one by one; a company that does not become
healthy is rolled back and the run stops), `remove-company.sh <slug>` (you must type the slug twice; takes a final backup into `archive/` first).

### First-customer test (do this before selling)
1. Create a company `test1`, open its URL, sign in, change the password, add a FOH and a KITCHEN user.
2. On two devices: send an order, mark it ready, pay it, download the report.
3. `backup.sh test1`, then `restore.sh test1 <file>` on a second throw-away company and confirm the data.
4. Create a second company `test2`; confirm test1's users cannot sign in there and the data is separate.
5. `docker stats` with a few companies running, to **measure** memory (I only estimate ~300-400 MB per company; not measured).

## 3. Operating it

- Backups: schedule `deploy/backup.sh` nightly (cron) and **copy the backup folder off the VPS**
  (a backup on the same disk does not survive losing the VPS). Test a restore every month.
- Monitoring: poll `https://<company>.yourdomain.com/health/ready` from an uptime service; alert on failure.
- Updates: `deploy/update-all.sh` (it takes the backup itself).
- Capacity: every company is its own set of containers, so cost grows linearly. Plan roughly one VPS
  per 15-30 small companies after you have measured; the stack-per-company design is deliberately the
  simple/safe choice, not the cheapest.

## 4. The Android and Windows apps (wrappers - not built yet)

The web app is already built to be wrapped (`VITE_APP_TARGET=wrapper` shows a "company code" screen first and
remembers the company; `VITE_ROUTER=hash` for Electron). Build it with:

```
cd frontend
VITE_APP_TARGET=wrapper VITE_BASE_DOMAIN=yourdomain.com npm run build                      # Android (Capacitor)
VITE_APP_TARGET=wrapper VITE_BASE_DOMAIN=yourdomain.com VITE_ROUTER=hash npm run build     # Windows (Electron)
```

Things the wrappers must match (already set in each company's CORS list):
- Capacitor: `androidScheme: "https"` → the app's origin is `https://localhost`.
- Electron: load the build from a custom protocol with host `rc` (origin `app://rc`).
- The company's server must be reached over HTTPS (Android blocks plain HTTP by default - good).

To do (outside this repo's current scope): Capacitor Android project + Play Console account (one-time US$25 fee;
verify current price), signing keystore (back it up - losing it means you cannot update the app),
Electron + installer (electron-builder), a Windows code-signing certificate (otherwise SmartScreen warns users),
app icons, privacy policy URL (Play Store requires one).

## 5. Before taking money from the first customer - checklist

Technical
- [ ] First-customer test above passed on the real VPS.
- [ ] Off-site backup running and one restore rehearsed.
- [ ] Uptime monitoring + a person who gets the alert.
- [ ] Rate-limit note: limits are per app process (fine here: one process per company).
- [ ] `npm audit` reviewed again at release time (known moderate advisory in exceljs→uuid, accepted, see AUDIT.md).

Business / legal (not built; needs decisions or a professional)
- [ ] Pricing, billing and invoicing (nothing automatic exists; no payment-gateway integration).
- [ ] Customer sign-up / onboarding flow (today: you run `new-company.sh` by hand).
- [ ] Terms of service, privacy policy, data-processing terms. Staff names, e-mails and sales data are
      personal/commercial data: check Indonesian personal-data-protection obligations (UU PDP) with a lawyer.
- [ ] Tax: the app computes tax per menu item, but it is **not** a certified tax/e-invoice (e-Faktur) system;
      do not market it as tax-compliant filing software without an accountant's review.
- [ ] Support process, SLA promise (do not promise uptime you have not measured), data-retention and
      company-deletion policy.
- [ ] Receipt printing is the browser's print dialog; thermal-printer integration is not built.
