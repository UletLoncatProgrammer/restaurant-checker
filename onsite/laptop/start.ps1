# Restaurant Checker - start the on-site version on this laptop (Windows + Podman).
# Use start.cmd (double-click). Safe to run again at any time: it keeps your data.
#   -NoBuild   skip rebuilding the app (faster, uses the version built last time)
param([switch]$NoBuild)

# ---- administrator rights (firewall + network forwarding need them) ----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Asking Windows for administrator rights (needed for the firewall and network forwarding)...'
  $argList = '-NoProfile -ExecutionPolicy Bypass -NoExit -File "' + $PSCommandPath + '"'
  if ($NoBuild) { $argList += ' -NoBuild' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
  Write-Host 'Continuing in the new (administrator) window. You can close this one.'
  exit
}

. (Join-Path $PSScriptRoot 'common.ps1')
Write-Host 'Restaurant Checker - on-site (laptop)' -ForegroundColor White

Say 'Checking Podman'
Assert-Podman
Ensure-Dirs

# ---- settings (first start asks a few questions) ----
$s = Read-Settings
if (-not $s.ContainsKey('POSTGRES_PASSWORD') -or -not $s.ContainsKey('JWT_SECRET')) {
  Say 'First start: a few questions about the restaurant'
  $company = Ask-Text 'Restaurant / company name' '' 2 80
  $branch  = Ask-Text 'Branch name' 'Main Branch' 1 60
  while ($true) {
    $email = "$(Read-Host 'Admin e-mail (only used to sign in, nothing is sent)')".Trim().ToLower()
    if ($email -match '^[^\s@"$\\`]+@[^\s@"$\\`]+\.[^\s@"$\\`]+$') { break }
    Warn 'That does not look like an e-mail address.'
  }
  while ($true) {
    $tables = "$(Read-Host 'Number of tables [10]')".Trim()
    if (-not $tables) { $tables = '10' }
    if ($tables -match '^\d{1,3}$' -and [int]$tables -le 200) { break }
    Warn 'Please type a number from 0 to 200.'
  }
  $tz = Ask-Tz
  $s = @{ POSTGRES_PASSWORD = (New-Hex 24); JWT_SECRET = (New-Hex 32); COMPANY_NAME = $company }
  $first = [pscustomobject]@{ company = $company; branch = $branch; email = $email; tables = $tables; tz = $tz }
  [System.IO.File]::WriteAllText($FirstRunFile, ($first | ConvertTo-Json), $Utf8NoBom)
  Ok "Settings will be kept in $DataDir"
}

# ---- addresses the tablets will use ----
Say 'Finding this laptop on the network'
$lan = Get-LanInfo
$tsIp = Get-TailscaleIp
$sites = @()
if ($lan) { $sites += "https://$($lan.Ip)"; Ok "Wi-Fi / network address: $($lan.Ip) ($($lan.Alias))" }
else { Warn 'No network with a router found. Only this laptop (https://localhost) will work until you join a Wi-Fi.' }
if ($tsIp) { $sites += "https://$tsIp"; Ok "Tailscale address: $tsIp" }
$sites += 'https://localhost'
$s['RC_SITES'] = ($sites -join ' ')
$s['CORS_ORIGIN'] = ($sites -join ',')
# certificate for tablets that open the plain Wi-Fi address (they send no name)
if ($lan) { $s['RC_DEFAULT_SNI'] = $lan.Ip } else { $s['RC_DEFAULT_SNI'] = 'localhost' }
Write-Settings $s

# ---- build the two local images ----
if (-not $NoBuild) {
  Say 'Building the app (first time 10-20 minutes and needs internet; after that about a minute)'
  $hadApp = Test-ImageExists 'localhost/rc-onsite-app:latest'
  & podman build -t localhost/rc-onsite-app:latest -f (Join-Path $RepoDir 'deploy\Dockerfile.app') $RepoDir
  if ($LASTEXITCODE -ne 0) {
    if ($hadApp) { Warn 'The new build failed; starting the version built last time.' }
    else { Fail 'The app could not be built. The first build downloads parts from the internet: check the connection and run start.cmd again.' }
  }
  $hadCaddy = Test-ImageExists 'localhost/rc-onsite-caddy:latest'
  & podman build -t localhost/rc-onsite-caddy:latest (Join-Path $OnsiteDir 'caddy')
  if ($LASTEXITCODE -ne 0 -and -not $hadCaddy) { Fail 'The HTTPS part (Caddy) could not be built. Check the internet connection and run start.cmd again.' }
} elseif (-not (Test-ImageExists 'localhost/rc-onsite-app:latest')) {
  Fail 'There is no app built yet. Run start.cmd without -NoBuild once.'
}

# ---- start ----
Say 'Starting the database, the app and HTTPS'
Invoke-Compose @('up', '-d')
if ($LASTEXITCODE -ne 0) { Fail 'Starting failed. If it says a port (80 or 443) is in use, another program is using it (for example IIS, XAMPP or Skype): close it and run start.cmd again.' }
if (-not (Wait-AppReady 180)) {
  & podman logs --tail 30 rc_onsite_app
  Fail 'The app did not become ready within 3 minutes. The last lines of its log are above.'
}
Ok 'The app is running'

# ---- first start: create the company and the first ADMIN ----
if (Test-Path $FirstRunFile) {
  Say 'Creating the restaurant and the first admin account'
  $f = [System.IO.File]::ReadAllText($FirstRunFile) | ConvertFrom-Json
  # answers saved by an earlier run may hold a short time-zone name: fix it up (or ask again)
  $fixedTz = Normalize-Tz $f.tz
  if (-not (Test-TzName $fixedTz)) { Warn "The time zone '$($f.tz)' is not valid."; $fixedTz = Ask-Tz }
  if ($fixedTz -ne $f.tz) {
    $f.tz = $fixedTz
    [System.IO.File]::WriteAllText($FirstRunFile, ($f | ConvertTo-Json), $Utf8NoBom)
    Ok "Time zone: $fixedTz"
  }
  $out = & podman exec rc_onsite_app node src/provision.js --company $f.company --location $f.branch --admin-email $f.email --admin-name Owner --tables $f.tables --timezone $f.tz 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $text = $out -join "`n"
  if ($code -eq 0) {
    $m = [regex]::Match($text, 'TEMPORARY_PASSWORD=(\S+)')
    Remove-Item $FirstRunFile -Force
    if ($m.Success) {
      $pw = $m.Groups[1].Value
      [System.IO.File]::WriteAllText($AdminPassFile, "Sign-in e-mail: $($f.email)`r`nTemporary password: $pw`r`nYou must choose your own password at first sign-in. Delete this file afterwards.`r`n", $Utf8NoBom)
      Write-Host ''
      Write-Host '   ==========================================================' -ForegroundColor Green
      Write-Host "    First admin sign-in:  $($f.email)" -ForegroundColor Green
      Write-Host "    Temporary password:   $pw" -ForegroundColor Green
      Write-Host '    (also saved in first-admin-password.txt in the settings folder;' -ForegroundColor Green
      Write-Host '     you must choose your own password when you sign in)' -ForegroundColor Green
      Write-Host '   ==========================================================' -ForegroundColor Green
    }
  } elseif ($text -match 'already has a company') {
    Remove-Item $FirstRunFile -Force
    Ok 'The restaurant was already created earlier.'
  } else {
    Write-Host $text
    Fail 'Creating the restaurant failed (message above). Run start.cmd again after fixing it; your answers are kept.'
  }
}

# ---- connect Windows (and tablets on the Wi-Fi) to the app inside Podman ----
Say 'Connecting this laptop and the Wi-Fi to the app'
Start-Service iphlpsvc -ErrorAction SilentlyContinue   # Windows service that does the forwarding
# remove the forwarding rules this script made last time (addresses can change)
if (Test-Path $ProxyIpFile) {
  foreach ($addr in (Get-Content $ProxyIpFile -ErrorAction SilentlyContinue)) {
    $a = "$addr".Trim()
    if (-not $a) { continue }
    foreach ($p in 80, 443) { & netsh interface portproxy delete v4tov4 listenport=$p listenaddress=$a *> $null }
  }
  Remove-Item $ProxyIpFile -Force -ErrorAction SilentlyContinue
}
$made = @()
if (Test-Port '127.0.0.1' 443) {
  $target = '127.0.0.1'
  Ok 'https://localhost answers directly'
} else {
  # A "rootful" Podman machine does not pass its ports to Windows. Forward to the machine's own
  # address instead (it changes when the machine restarts, so this is redone on every start).
  $vmIp = Get-PodmanVmIp
  if (-not $vmIp) { Fail "Could not find the Podman machine's network address. Run diagnose.cmd and tell me when it says Done." }
  if (-not (Test-Port $vmIp 443)) { Fail "Windows cannot reach the Podman machine ($vmIp) on port 443. Run diagnose.cmd and tell me when it says Done." }
  foreach ($p in 80, 443) { & netsh interface portproxy add v4tov4 listenport=$p listenaddress=127.0.0.1 connectport=$p connectaddress=$vmIp | Out-Null }
  $made += '127.0.0.1'
  Start-Sleep -Seconds 1
  if (-not (Test-Port '127.0.0.1' 443)) { Fail "Forwarding https://localhost to the Podman machine ($vmIp) did not work. Run diagnose.cmd and tell me when it says Done." }
  $target = $vmIp
  Ok "https://localhost -> Podman machine ($vmIp)"
}

if (-not (Get-NetFirewallRule -DisplayName 'Restaurant Checker' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Restaurant Checker' -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow -Profile Private,Domain | Out-Null
  Ok 'Firewall: allowed ports 80 and 443 on private networks'
} else { Ok 'Firewall rule already there' }

if ($lan) {
  $netProfile = Get-NetConnectionProfile -InterfaceIndex $lan.IfIndex -ErrorAction SilentlyContinue
  if ($netProfile -and "$($netProfile.NetworkCategory)" -eq 'Public') {
    Warn "Windows treats this Wi-Fi ($($netProfile.Name)) as a PUBLIC network, which blocks tablets."
    if (Ask-YesNo 'Mark it as a PRIVATE (home/work) network? Only do this on your own Wi-Fi.') {
      Set-NetConnectionProfile -InterfaceIndex $lan.IfIndex -NetworkCategory Private
      Ok 'Network set to Private'
    } else { Warn 'Left as Public: tablets will probably not be able to connect.' }
  }
  if (Test-Port $lan.Ip 443) {
    Ok "Tablets can reach $($lan.Ip) directly"
  } else {
    foreach ($p in 80, 443) { & netsh interface portproxy add v4tov4 listenport=$p listenaddress=$($lan.Ip) connectport=$p connectaddress=$target | Out-Null }
    $made += $lan.Ip
    Start-Sleep -Seconds 1
    if (Test-Port $lan.Ip 443) { Ok "Tablets: $($lan.Ip) -> the app (ports 80, 443)" }
    else { Warn "Could not open $($lan.Ip):443 for tablets. The app still works on this laptop at https://localhost. Run diagnose.cmd and tell me." }
  }
}
if ($made.Count -gt 0) { Set-Content -Path $ProxyIpFile -Value $made -Encoding ASCII }
# Real end-to-end check, the way a tablet connects (plain address, no name sent).
if ($lan -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Start-Sleep -Seconds 2
  $code = & curl.exe -sk -o NUL -w '%{http_code}' --max-time 8 "https://$($lan.Ip)/health" 2>$null
  if ("$code" -eq '200') { Ok "A tablet opening https://$($lan.Ip) gets the app" }
  else { Warn "https://$($lan.Ip) did not answer correctly (code '$code'). Run diagnose.cmd and tell me." }
}

# ---- certificate (lets tablets trust this laptop's HTTPS) ----
Say 'Getting the HTTPS certificate for tablets'
$gotCert = $false
for ($i = 0; $i -lt 15; $i++) {
  & podman cp rc_onsite_caddy:/data/caddy/pki/authorities/local/root.crt $CertFile 2>$null
  if ($LASTEXITCODE -eq 0 -and (Test-Path $CertFile)) { $gotCert = $true; break }
  Start-Sleep -Seconds 2
}
if ($gotCert) {
  Ok "Saved: $CertFile"
  $trusted = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like '*Caddy Local Authority*' -and $_.Thumbprint -eq (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertFile)).Thumbprint }
  if (-not $trusted) {
    if (Ask-YesNo 'Trust this certificate on THIS laptop too (so Edge/Chrome show no warning at https://localhost)?') {
      Import-Certificate -FilePath $CertFile -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
      Ok 'Trusted on this laptop'
    }
  }
} else { Warn 'Could not copy the certificate yet. Tablets can still download it from the address below.' }

# ---- keep the laptop awake while it serves tablets ----
# The last two hex values printed are the plugged-in (AC) and battery (DC) settings, in any Windows language.
$hex = @([regex]::Matches(((& powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null) -join "`n"), '0x[0-9a-fA-F]{8}') | ForEach-Object { $_.Value })
$ac = $null
if ($hex.Count -ge 2) { $ac = $hex[$hex.Count - 2] }
if ($ac -and $ac -ne '0x00000000') {
  if (Ask-YesNo 'This laptop goes to sleep when plugged in, which disconnects the tablets. Turn sleep off while plugged in?') {
    & powercfg /change standby-timeout-ac 0
    Ok 'Sleep while plugged in: never'
  }
}

# ---- done ----
Write-Host ''
Write-Host '   ==========================================================' -ForegroundColor Cyan
Write-Host '    Restaurant Checker is running.' -ForegroundColor Cyan
Write-Host '    On this laptop:   https://localhost' -ForegroundColor Cyan
if ($lan) {
  Write-Host '    On a tablet (same Wi-Fi):' -ForegroundColor Cyan
  Write-Host "      1. Open  http://$($lan.Ip)/rc-root.crt  and install it (once, see README)" -ForegroundColor Cyan
  Write-Host "      2. Open  https://$($lan.Ip)" -ForegroundColor Cyan
}
if ($tsIp) { Write-Host "    Remote (Tailscale): https://$tsIp" -ForegroundColor Cyan }
Write-Host "    Settings, backups, certificate: $DataDir" -ForegroundColor Cyan
Write-Host '    Stop: stop.cmd     Backup: backup.cmd' -ForegroundColor Cyan
Write-Host '   ==========================================================' -ForegroundColor Cyan
