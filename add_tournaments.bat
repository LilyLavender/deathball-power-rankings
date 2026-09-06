@echo off
setlocal
cd /d "%~dp0"

echo === Adding tournaments ===
node data\players\add_tournaments.js
if errorlevel 1 goto :error

echo === Done ===
exit /b 0

:error
echo Adding tournaments failed.
exit /b 1
