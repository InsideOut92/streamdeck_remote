@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo [StreamDeck Remote] EXE Builder
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte Node.js 18+ installieren.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm wurde nicht gefunden. Bitte Node.js/npm Installation pruefen.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] Installiere Abhaengigkeiten ...
  call npm ci
  if errorlevel 1 goto :fail
) else (
  echo [1/3] Abhaengigkeiten vorhanden.
)

echo [2/3] Baue EXE ...
call npm run build:win
if errorlevel 1 goto :fail

echo [3/3] Fuehre EXE-Smoketest aus ...
call npm run smoke:exe
if errorlevel 1 goto :fail

echo.
echo Fertig. EXE liegt hier:
echo   dist\streamdeck_remote.exe
echo.
pause
exit /b 0

:fail
echo.
echo Fehler beim Erstellen der EXE. Details stehen oben.
echo.
pause
exit /b 1
