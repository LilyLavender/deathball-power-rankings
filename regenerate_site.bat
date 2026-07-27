@echo off
setlocal
cd /d "%~dp0"

echo === Regenerating power rankings site ===
node data\players\aggregate_players.js
if errorlevel 1 goto :error

echo === Regenerating player connections graph ===
node data\players\player_graph.js
if errorlevel 1 goto :error

echo === Done ===
exit /b 0

:error
echo Regeneration failed.
exit /b 1
