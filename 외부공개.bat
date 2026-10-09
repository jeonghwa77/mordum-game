@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1"
if errorlevel 1 pause
