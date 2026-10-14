# Restaurant Checker - stop on this laptop. Your data stays; start.cmd brings it back.
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Test-Path $EnvFile)) { Fail 'Nothing to stop: Restaurant Checker was never started on this laptop.' }
Say 'Stopping Restaurant Checker (data is kept)'
Invoke-Compose @('stop')
if ($LASTEXITCODE -ne 0) { Fail 'Could not stop it. Is the Podman machine running?' }
Ok 'Stopped. Tablets cannot connect until you run start.cmd again.'
