# Restaurant Checker - put a backup back. REPLACES all current data.
#   restore.cmd                 (uses the newest backup)
#   restore.cmd <file.dump>
param([string]$File)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $File) {
  $latest = Get-ChildItem $BackupDir -Filter 'rc-*.dump' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { Fail "No backups found in $BackupDir" }
  $File = $latest.FullName
}
if (-not (Test-Path $File)) { Fail "File not found: $File" }
Write-Host "This REPLACES everything in Restaurant Checker with the backup:" -ForegroundColor Yellow
Write-Host "   $File" -ForegroundColor Yellow
if ((Read-Host 'Type RESTORE to continue') -ne 'RESTORE') { Fail 'Cancelled.' }

Say 'Taking a safety backup of the current data first'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'backup.ps1')
Say 'Restoring'
Invoke-Compose @('stop', 'app')
& podman cp $File rc_onsite_db:/tmp/rc-restore.dump
if ($LASTEXITCODE -ne 0) { Invoke-Compose @('start', 'app'); Fail 'Could not copy the backup into the database container.' }
& podman exec rc_onsite_db pg_restore --clean --if-exists --no-owner -U rc -d rc /tmp/rc-restore.dump
$code = $LASTEXITCODE
& podman exec rc_onsite_db rm -f /tmp/rc-restore.dump
Invoke-Compose @('start', 'app')
if ($code -ne 0) { Warn 'pg_restore reported problems (messages above). Check the app before using it.' } else { Ok 'Restored.' }
if (-not (Wait-AppReady 120)) { Warn 'The app is slow to come back; check https://localhost in a minute.' } else { Ok 'The app is running again.' }
Write-Host '   Everyone must sign in again if the backup is older than their last password change.'
