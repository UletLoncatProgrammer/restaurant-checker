# Restaurant Checker - copy the whole database to a file (keeps the newest 14).
. (Join-Path $PSScriptRoot 'common.ps1')
Ensure-Dirs
Say 'Backing up the database'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $BackupDir "rc-$stamp.dump"
& podman exec rc_onsite_db pg_dump -U rc -d rc -Fc -f /tmp/rc-backup.dump
if ($LASTEXITCODE -ne 0) { Fail 'The backup failed. Is Restaurant Checker running (start.cmd)?' }
& podman cp rc_onsite_db:/tmp/rc-backup.dump $dest
$copied = ($LASTEXITCODE -eq 0)
& podman exec rc_onsite_db rm -f /tmp/rc-backup.dump
if (-not $copied -or -not (Test-Path $dest)) { Fail 'The backup was made but could not be copied to this laptop.' }
Ok ("Saved {0} ({1:N0} KB)" -f $dest, ((Get-Item $dest).Length / 1KB))
Get-ChildItem $BackupDir -Filter 'rc-*.dump' | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item -Force
Write-Host '   A backup on the same laptop does not survive losing the laptop: copy this folder somewhere else too.'
