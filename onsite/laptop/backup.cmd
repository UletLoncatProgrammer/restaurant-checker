@echo off
rem Saves a copy of the database in %%LOCALAPPDATA%%\RestaurantChecker\backups
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1"
pause
