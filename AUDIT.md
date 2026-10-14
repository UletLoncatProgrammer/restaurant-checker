# Commercial-readiness audit - Restaurant Checker

Scope: backend (Express/Postgres), web app (React), Docker/deploy tooling.
Method: code read-through plus automated tests against a real Postgres (backend 26 tests incl. 13 security tests; frontend 30 tests; production build of both web and "wrapper" variants).
**Not tested:** the Docker/VPS/Caddy flow on a real server, the Android/Windows wrappers (not built), load/capacity, an external penetration test.

## Findings and status

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Critical | Open self-sign-up: anyone who found the server could create a login that reads that company's orders and menu | Fixed - removed; ADMIN creates staff (`POST /users`) |
| 2 | Critical | Default/weak secrets accepted (`JWT_SECRET`, `restaurant/restaurant` DB password, CORS `*`) incl. in `docker-compose.yml` with published DB port | Fixed - production refuses to start with a short/placeholder secret, `*` CORS or the default DB password; root compose is now dev-only and bound to 127.0.0.1; per-company secrets are random |
| 3 | High | A token stayed valid for its whole life after a user was disabled, demoted or had the password reset | Fixed - every request re-checks the user in the DB; `token_version` revokes old logins; sockets are disconnected |
| 4 | High | No brute-force protection | Fixed - per-account lockout (5 fails → 5 min) + per-IP rate limit on sign-in; audit events |
| 5 | High | Temporary/known passwords never forced to change | Fixed - `must_change_password`; API refuses everything else (`PASSWORD_CHANGE_REQUIRED`) until changed |
| 6 | High | Cross-tenant references possible at DB level (an order/menu item pointing at another location's table/category) | Fixed - triggers `rc_check_same_location()` + CHECK constraints; tested |
| 7 | Medium | No security headers / permissive CORS | Fixed - helmet + CSP, explicit origin list |
| 8 | Medium | Container ran as root, no healthcheck | Fixed - non-root user, `/health/ready` healthcheck |
| 9 | Medium | No audit trail for sign-ins and staff changes | Fixed - `auth_events` table |
| 10 | Medium | Menu/table/staff could not be managed from the UI | Fixed - Admin screen (staff, menu, tables) |
| 11 | Medium | No way to host many companies safely | Added - stack-per-company tooling (`deploy/`), per-company CORS/secrets/backups |
| 12 | Low | `exceljs` pulls a `uuid` version with a moderate advisory | Accepted - used only to write reports server-side; recheck at release |

## Residual risks (read these)

1. **Cloud-only: no internet = no orders.** Accepted for v1 by the owner. This is the biggest product risk for a restaurant (an ISP outage during service). No offline queue exists.
2. **Deploy tooling is unproven on a real server.** Verified by syntax check, dry runs and YAML parsing only. Run the first-customer test in `deploy/README.md`.
3. **Per-process rate limiting.** Counters live in memory, reset on restart. Acceptable with one process per company; would need Redis if a company ever runs several app processes.
4. **ADMIN is per branch.** There is no owner account spanning several branches/companies; a multi-branch owner needs separate logins today.
5. **Staff devices.** The web app keeps its token in browser storage (needed for the Android/Windows wrappers too). Anyone with a staff member's unlocked device is that staff member; the 12 h token life and "disable user" revocation limit this, they do not remove it. Right-click blocking is a deterrent only, not security.
6. **Backups live on the same VPS** until you add an off-site copy; the scripts do not do that for you.
7. **Capacity numbers are estimates** (~300-400 MB per company) - measure with `docker stats`.
8. **Not a certified tax/e-invoice system** and no payment-gateway or thermal-printer integration; billing, customer sign-up, ToS/privacy and legal review (Indonesian data-protection law) are business work still to do.
9. Wrapper builds assume absolute asset paths (`/assets/...`); the Electron wrapper must serve them from a custom protocol (`app://rc`), not `file://`.

## What I changed (short)

Backend: config fail-fast, DB-rechecked auth with revocation, lockout/rate limits, forced password change, staff/menu/table admin endpoints, audit log, DB triggers/constraints, provisioning CLI, non-root image.
Frontend: runtime company code / server setting, Connect + Login + Change-password + Admin screens, sign-up removed, hash-router option for Electron.
Ops: `deploy/` (edge proxy with automatic HTTPS, per-company stack, create/list/backup/restore/update/remove scripts), CI uses `npm ci`.
