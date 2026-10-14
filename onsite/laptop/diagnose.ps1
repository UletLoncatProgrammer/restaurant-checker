# Restaurant Checker - collect information for troubleshooting into diagnose-output.txt
# (next to this script). It does not change anything and does not print passwords.
. (Join-Path $PSScriptRoot 'common.ps1')
$Out = Join-Path $LaptopDir 'diagnose-output.txt'
$lines = New-Object System.Collections.ArrayList
function Add([string]$title, $value) {
  [void]$lines.Add('')
  [void]$lines.Add("### $title")
  foreach ($v in @($value)) { [void]$lines.Add("$v") }
}
function Run([string]$title, [scriptblock]$sb) {
  try { $r = & $sb 2>&1 | ForEach-Object { "$_" } } catch { $r = "ERROR: $($_.Exception.Message)" }
  Add $title $r
}

Write-Host 'Collecting information (about 30 seconds)...'
Add 'time' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
Run 'windows' { (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSLanguage | Format-List | Out-String).Trim() }
Run 'is admin' { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
Run 'podman version' { & podman version }
Run 'podman machine list' { & podman machine list }
Run 'podman machine inspect (rootful / networking)' { & podman machine inspect | Select-String -Pattern 'Rootful|UserModeNetworking|"Name"|State' }
Run 'podman ps -a' { & podman ps -a --format '{{.Names}} | {{.Status}} | {{.Ports}}' }
Run 'caddy log (last 40)' { & podman logs --tail 40 rc_onsite_caddy }
Run 'app log (last 40)' { & podman logs --tail 40 rc_onsite_app }
Run 'db log (last 15)' { & podman logs --tail 15 rc_onsite_db }
Run 'company / users in database' { & podman exec rc_onsite_db psql -U rc -d rc -tAc "select 'organizations=' || count(*) from organizations union all select 'users=' || count(*) from users" }
Run 'settings file' {
  if (Test-Path $EnvFile) { [System.IO.File]::ReadAllLines($EnvFile) | ForEach-Object { if ($_ -match '^(POSTGRES_PASSWORD|JWT_SECRET)=') { ($_ -split '=')[0] + '=<hidden>' } else { $_ } } } else { 'settings.env missing' }
}
Run 'first-run.json present' { Test-Path $FirstRunFile }
Run 'files in settings folder' { Get-ChildItem $DataDir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } }
Run 'lan' { Get-LanInfo | Format-List | Out-String }
Run 'network profile' { Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, NetworkCategory | Format-Table | Out-String }
Run 'windows listening on 80/443' { netstat -ano | Select-String -Pattern ':(80|443)\s' }
Run 'portproxy' { netsh interface portproxy show all }
Run 'test 127.0.0.1:443' { Test-Port '127.0.0.1' 443 }
Run 'test 127.0.0.1:80' { Test-Port '127.0.0.1' 80 }
Run 'test [::1]:443' { Test-Port '::1' 443 }
Run 'curl https://localhost (windows)' { & curl.exe -sk -o NUL -w 'http=%{http_code} err=%{errormsg}' --max-time 5 https://localhost/health }
Run 'curl https://<wifi address>/health (like a tablet)' { $l = Get-LanInfo; if ($l) { & curl.exe -sk -o NUL -w 'http=%{http_code} err=%{errormsg}' --max-time 8 "https://$($l.Ip)/health" } else { 'no wifi' } }
Run 'curl http://localhost/rc-root.crt (windows)' { & curl.exe -s -o NUL -w 'http=%{http_code}' --max-time 5 http://localhost/rc-root.crt }
Run 'inside podman machine: listening' { & podman machine ssh 'ss -ltn' }
Run 'inside podman machine: curl https://localhost' { & podman machine ssh 'curl -sk -o /dev/null -w "http=%{http_code}" --max-time 5 https://localhost/health || echo curl-failed' }
Run 'inside podman machine: ip' { & podman machine ssh 'ip -4 -o addr show eth0' }
Run 'podman machine address (as start.cmd sees it)' { Get-PodmanVmIp }
Run 'test machine address :443 from windows' { $ip = Get-PodmanVmIp; if ($ip) { Test-Port $ip 443 } else { 'no address' } }
Run 'caddy -> app inside network' { & podman exec rc_onsite_caddy wget -q -O - http://app:4000/health }

[System.IO.File]::WriteAllText($Out, ($lines -join "`r`n"), $Utf8NoBom)
Write-Host "Done. Saved: $Out" -ForegroundColor Green
