@echo off
chcp 65001 >nul
title International TMS - 首次安装并启动 5189
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

echo [1/3] 安装锁定版本依赖...
call npm ci
if errorlevel 1 goto :failed

echo [2/3] 应用本地 D1 增量迁移...
call npm run db:migrate:local
if errorlevel 1 goto :failed

echo [3/3] 启动 International TMS...
call "启动当前测试系统.cmd"
goto :end

:failed
echo.
echo [失败] 请把本窗口错误截图发给开发人员。
pause
exit /b 1

:end
pause

