@echo off
rem Collects troubleshooting information into diagnose-output.txt (changes nothing).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
pause
