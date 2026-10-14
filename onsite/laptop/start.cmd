@echo off
rem Starts Restaurant Checker on this laptop. Double-click me.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
