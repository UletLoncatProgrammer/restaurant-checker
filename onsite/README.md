# Restaurant Checker - on-site (offline) version

The server runs on one machine **inside the restaurant**. Tablets, the kitchen screen and the
cashier connect to it over the restaurant Wi-Fi, so orders keep working when the internet is down.
The internet is only used for remote access (Tailscale) and the off-site backup copy.
Picture: `../offline-architecture.png`.

Two ways to install the same thing:

| | Laptop (try it) | Mini PC (real restaurant) |
|---|---|---|
| System | Windows 11 + Podman Desktop | Ubuntu 22.04 / 24.04 |
| Start | `laptop\start.cmd` (double-click) | `sudo bash minipc/rc.sh install` once, then automatic |
| Runs when | you start it | always, starts by itself after a power cut |
| Use for | testing | service |

A laptop is fine for trying it, **not** for running a restaurant: it sleeps, restarts for Windows
updates, gets carried home, and its Wi-Fi address can change.

---

## A. Laptop (Windows + Podman)

Needs: Podman Desktop with a running Podman machine and Compose set up
(`podman compose version` prints a version). Internet for the first start only.

1. Open the folder `onsite\laptop` and double-click **start.cmd**. Click **Yes** when Windows asks
   for administrator rights (needed for the firewall and network forwarding).
2. First time only, it asks: restaurant name, branch, admin e-mail, number of tables, time zone.
3. It builds the app (first time 10-20 minutes), starts it, and shows the **first admin e-mail and
   temporary password**. They are also saved in
   `%LOCALAPPDATA%\RestaurantChecker\first-admin-password.txt` - delete that file after signing in.
4. It may ask three Yes/No questions:
   - mark your Wi-Fi as *Private* (only on your own Wi-Fi; Public networks block tablets),
   - trust the certificate on this laptop (so Edge/Chrome show no warning),
   - turn off sleep while plugged in.
5. The browser opens `https://localhost`. Sign in and choose your own password.

Other buttons in the same folder: **stop.cmd** (data is kept), **backup.cmd**, **restore.cmd**.
Settings, backups and the certificate are in `%LOCALAPPDATA%\RestaurantChecker` (not in OneDrive).
The database itself lives inside the Podman machine: if you delete or reset the Podman machine,
the data is gone - make a backup first.

## B. Tablets (same for laptop and mini PC)

Each tablet must trust the server's certificate **once**. Without it the browser shows a warning,
and the kitchen screen cannot stay awake.

1. Join the same Wi-Fi as the server.
2. Open `http://<server address>/rc-root.crt` (the address is printed at the end of start/install,
   e.g. `http://192.168.1.50/rc-root.crt`). The file downloads.
3. Install it:
   - **Android:** Settings -> search **"CA certificate"** (usually Security -> More security settings
     -> Encryption & credentials -> Install a certificate -> CA certificate) -> *Install anyway* ->
     choose `rc-root.crt`. Menu names differ by brand.
   - **iPad / iPhone:** open the address in Safari -> *Allow* -> Settings -> *Profile Downloaded* ->
     Install. Then Settings -> General -> About -> **Certificate Trust Settings** -> turn on
     *Caddy Local Authority*.
4. Open `https://<server address>` and add it to the home screen.

The certificate stays valid for years and survives restarts. It only changes if the server's data
(the Caddy volume) is deleted - then tablets must install the new one.

## C. Mini PC (Ubuntu)

1. Install Ubuntu Server or Desktop 24.04 on the mini PC; connect it to the restaurant router by
   **cable** if possible.
2. In the router, give the mini PC a **fixed address** (DHCP reservation), so tablets keep working.
3. Copy this whole project folder to the mini PC (for example `/opt/restaurant-checker`).
4. `cd /opt/restaurant-checker/onsite/minipc && sudo bash rc.sh install`
   It installs Podman (or uses Docker if it is already there), asks the same questions as the
   laptop, builds, starts, prints the first admin password, and sets up:
   - start at boot (`restaurant-checker.service`), also after a power cut,
   - follow a changed Wi-Fi address within 5 minutes,
   - backup every night at 02:30 to `/var/backups/restaurant-checker` (newest 14 kept).
5. Put the mini PC on a **UPS** (battery backup) together with the router.

Commands: `sudo ./rc.sh status | start | stop | backup | restore [file] | update`.

### Off-site backup (do this before going live)
A backup on the same PC does not survive theft, fire or a dead disk. Add a destination in
`/etc/restaurant-checker/settings.env`:

```
RC_OFFSITE="backup@100.101.102.103:/srv/backups/my-restaurant/"
```

The nightly backup then copies the folder there with `rsync` (needs SSH key login from the mini PC's
root account to that machine; your VPS over Tailscale works). If the internet is down, the copy is
retried the next night. Test a restore once: `sudo ./rc.sh restore`.

### Remote access with Tailscale (optional)
On the mini PC: install Tailscale from https://tailscale.com/download and run `sudo tailscale up`.
Within 5 minutes the server also answers at `https://<tailscale address>`. The owner's phone or
laptop needs Tailscale and the certificate (section B) too. Tablets keep using the Wi-Fi address,
not Tailscale.

---

## When something goes wrong

| Problem | What to do |
|---|---|
| start.cmd: "Podman is not installed" | Install Podman Desktop, start its machine, run again |
| "port 80/443 is in use" | Another web server is running (IIS, XAMPP, Skype). Stop it, run again |
| Works on the laptop, not on the tablet | Same Wi-Fi? Wi-Fi marked Private? Run start.cmd again (it re-checks forwarding). Send a screenshot of its window |
| Tablet shows a certificate warning | Install `rc-root.crt` on it (section B) |
| Laptop's Wi-Fi address changed | Run start.cmd again (mini PC does this by itself) |
| Forgot the admin password | Another ADMIN can reset it in Admin -> Staff. If there is no other admin, ask for help (there is no e-mail reset offline) |

## Honest limits (read before using it in a restaurant)

- **Tested:** the app itself in this exact production configuration (settings, first-admin creation,
  sign-in, password change, origin checks). **Not yet tested on real hardware:** the Windows scripts,
  the Caddy HTTPS front, Podman/WSL network forwarding, and the mini PC installer. Tonight's laptop
  test is that first real run.
- The server is a single machine. If it breaks, orders stop until it is fixed or replaced and the
  backup is restored. Keep the off-site backup working.
- Owners only see live data from home while the restaurant's internet works.
- The future Android app must be built to trust this certificate (normal browsers on Android do,
  after step B).
