@echo off
rem Stops Restaurant Checker on this laptop (your data is kept).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
pause
