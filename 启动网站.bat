@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 沈飞公司 - 检测报告进度控制中心

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8765'"

where node >nul 2>nul
if not errorlevel 1 (
  node server.js
  goto :end
)

set "BUNDLED_NODE=C:\Users\Louie_LU\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BUNDLED_NODE%" (
  "%BUNDLED_NODE%" server.js
  goto :end
)

where py >nul 2>nul
if not errorlevel 1 (
  py server.py
  goto :end
)

where python >nul 2>nul
if not errorlevel 1 (
  python server.py
  goto :end
)

echo 未找到 Node.js 或 Python，网站无法启动。
echo 请安装其中任意一个后再双击本文件。
pause

:end
if errorlevel 1 pause
