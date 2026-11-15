@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=%PATH%;%ProgramFiles%\nodejs"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
title PULSE build
echo Собираю PULSE.exe, это 1-3 минуты. Лог: build_log.txt
call :main > build_log.txt 2>&1
if errorlevel 1 (
  type build_log.txt
  pause
)
exit /b

:main
echo BUILD %date% %time%
taskkill /im PULSE.exe /f >nul 2>&1
timeout /t 2 /nobreak >nul
call npx electron-builder --win portable
echo BUILD_EXIT %errorlevel%
if not exist dist\PULSE.exe exit /b 1
powershell -NoProfile -Command "Copy-Item -Force 'dist\PULSE.exe' (Join-Path ([Environment]::GetFolderPath('Desktop')) 'PULSE.exe')"
echo COPIED_TO_DESKTOP %errorlevel%
exit /b 0
