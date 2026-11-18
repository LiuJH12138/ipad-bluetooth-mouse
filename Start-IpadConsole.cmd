@echo off
powershell.exe -NoLogo -NoProfile -File "%~dp0Start-IpadConsole.ps1"
if errorlevel 1 pause
