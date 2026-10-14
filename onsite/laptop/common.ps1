# Shared helpers for the laptop scripts (Windows PowerShell 5.1 or newer + Podman).
# Keep this file plain ASCII: Windows PowerShell 5.1 misreads other characters.

$ErrorActionPreference = 'Continue'
$env:PODMAN_COMPOSE_WARNING_LOGS = 'false'   # hide the "Executing external compose provider" banner

$LaptopDir   = $PSScriptRoot
$OnsiteDir   = Split-Path -Parent $LaptopDir
$RepoDir     = Split-Path -Parent $OnsiteDir
$ComposeFile = Join-Path $OnsiteDir 'compose.yml'
$Project     = 'rc_onsite'

# Settings, secrets, backups and the certificate live OUTSIDE OneDrive, on this laptop only.
$DataDir       = Join-Path $env:LOCALAPPDATA 'RestaurantChecker'
$EnvFile       = Join-Path $DataDir 'settings.env'
$FirstRunFile  = Join-Path $DataDir 'first-run.json'
$BackupDir     = Join-Path $DataDir 'backups'
$CertFile      = Join-Path $DataDir 'rc-root.crt'
$ProxyIpFile   = Join-Path $DataDir 'portproxy-ip.txt'
$AdminPassFile = Join-Path $DataDir 'first-admin-password.txt'

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say([string]$m)  { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Fail([string]$m) {
  Write-Host ''
  Write-Host "STOPPED: $m" -ForegroundColor Red
  Write-Host 'Nothing else was changed. Send a screenshot of this window if you need help.'
  exit 1
}

function Ensure-Dirs {
  foreach ($d in @($DataDir, $BackupDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
  }
}

function Read-Settings {
  $h = @{}
  if (Test-Path $EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
      if ($line -match '^\s*([A-Z_]+)=(.*)$') {
        $v = $Matches[2].Trim()
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
        $h[$Matches[1]] = $v
      }
    }
  }
  return $h
}

function Write-Settings($h) {
  $keys = @('POSTGRES_PASSWORD', 'JWT_SECRET', 'COMPANY_NAME', 'RC_SITES', 'CORS_ORIGIN', 'RC_DEFAULT_SNI')
  $lines = @('# Restaurant Checker (laptop) settings. Written by start.ps1 - keep this file private.')
  foreach ($k in $keys) { if ($h.ContainsKey($k)) { $lines += ($k + '="' + $h[$k] + '"') } }
  [System.IO.File]::WriteAllText($EnvFile, (($lines -join "`r`n") + "`r`n"), $Utf8NoBom)
}

function New-Hex([int]$bytes) {
  $b = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Text answers end up in a settings file and a command line: no quotes, $, backslash or backtick.
function Ask-Text([string]$question, [string]$default, [int]$min, [int]$max) {
  while ($true) {
    $prompt = $question
    if ($default) { $prompt = "$question [$default]" }
    $a = Read-Host $prompt
    if (-not $a) { $a = $default }
    $a = "$a".Trim()
    if ($a.Length -lt $min -or $a.Length -gt $max) { Warn "Please use $min to $max characters."; continue }
    if ($a -match '["$\\`]') { Warn 'Please do not use quotes, $, \ or backtick.'; continue }
    return $a
  }
}

function Ask-YesNo([string]$question) {
  while ($true) {
    $a = (Read-Host "$question (Y/N)").Trim().ToUpper()
    if ($a -eq 'Y') { return $true }
    if ($a -eq 'N') { return $false }
  }
}

function Invoke-Compose([string[]]$ComposeArgs) {
  & podman compose -p $Project --env-file $EnvFile -f $ComposeFile @ComposeArgs
}

function Test-ImageExists([string]$name) {
  & podman image exists $name 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Assert-Podman {
  if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    Fail 'Podman is not installed (or not on PATH). Install Podman Desktop first: https://podman-desktop.io/downloads'
  }
  & podman info *> $null
  if ($LASTEXITCODE -ne 0) {
    Warn 'The Podman machine is not running. Starting it...'
    & podman machine start
    Start-Sleep -Seconds 5
    & podman info *> $null
    if ($LASTEXITCODE -ne 0) { Fail 'Podman is installed but its machine does not answer. Open Podman Desktop, start the machine, then run this again.' }
  }
  Ok 'Podman is running'
}

# TCP connect with a short timeout (Test-NetConnection is very slow when it fails).
function Test-Port([string]$ip, [int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($ip, $port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(2000)) { $c.EndConnect($iar); return $true }
    return $false
  } catch { return $false } finally { $c.Close() }
}

# The Wi-Fi / network card that has a router (default gateway). Returns $null when offline.
function Get-LanInfo {
  $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter -ne $null -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object -First 1
  if (-not $cfg) { return $null }
  $ip = @($cfg.IPv4Address)[0].IPAddress
  return [pscustomobject]@{ Ip = $ip; IfIndex = $cfg.InterfaceIndex; Alias = $cfg.InterfaceAlias }
}

function Get-TailscaleIp {
  if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { return $null }
  $out = & tailscale ip -4 2>$null | Select-Object -First 1
  if ("$out" -match '^100\.\d+\.\d+\.\d+$') { return "$out" }
  return $null
}

function Wait-AppReady([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    & podman exec rc_onsite_app wget -q -O /dev/null http://127.0.0.1:4000/health/ready 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

# Friendly time-zone answers -> the full name the app needs (e.g. "Jakarta" -> "Asia/Jakarta").
function Normalize-Tz([string]$tz) {
  $t = "$tz".Trim()
  switch -Regex ($t.ToLower()) {
    '^(jakarta|wib|jkt)$'                     { return 'Asia/Jakarta' }
    '^(makassar|wita|bali|denpasar)$'         { return 'Asia/Makassar' }
    '^(jayapura|wit|papua)$'                  { return 'Asia/Jayapura' }
    '^singapore$'                             { return 'Asia/Singapore' }
    '^(kuala lumpur|kl)$'                     { return 'Asia/Kuala_Lumpur' }
  }
  return $t
}
function Test-TzName([string]$tz) { return ($tz -match '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$') }
function Ask-Tz {
  while ($true) {
    $t = Normalize-Tz (Ask-Text 'Time zone (Jakarta, Makassar, Jayapura, or a name like Asia/Jakarta)' 'Asia/Jakarta' 2 60)
    if (Test-TzName $t) { return $t }
    Warn 'Please type Jakarta, Makassar, Jayapura, or a full name such as Asia/Jakarta.'
  }
}

# The Podman (WSL) machine's own IPv4 address, seen from Windows. Changes when the machine restarts.
function Get-PodmanVmIp {
  $raw = (& podman machine ssh 'ip -4 -o addr show eth0' 2>$null) -join ' '
  $m = [regex]::Match($raw, 'inet (\d+\.\d+\.\d+\.\d+)')
  if ($m.Success) { return $m.Groups[1].Value }
  # fallback without the "ip" tool: the kernel's own table of local addresses
  $lines = @(& podman machine ssh 'cat /proc/net/fib_trie' 2>$null)
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ("$($lines[$i])" -match '/32 host LOCAL') {
      $c = [regex]::Match("$($lines[$i - 1])", '(\d+\.\d+\.\d+\.\d+)')
      if ($c.Success -and -not $c.Value.StartsWith('127.') -and -not $c.Value.StartsWith('10.88.') -and -not $c.Value.StartsWith('10.89.')) { return $c.Value }
    }
  }
  return $null
}
