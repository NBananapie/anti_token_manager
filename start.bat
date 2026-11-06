@echo off
title Antigravity Token Manager & Model Monitor
cd /d "%~dp0"

echo ========================================================
echo   Antigravity Token 消耗审计与模型路由监测后台
echo   正在启动监控服务 (http://127.0.0.1:3820)...
echo ========================================================

start "" "http://127.0.0.1:3820"
node web/server.js
pause
