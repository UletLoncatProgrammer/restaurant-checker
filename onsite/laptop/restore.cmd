@echo off
rem Puts a backup back (replaces current data). Optional: restore.cmd "path\to\file.dump"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" %*
pause
