@echo off
chcp 65001 >nul
title International TMS - 当前测试系统 5189
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [提示] 未找到 node_modules，正在安装依赖...
  call npm ci
  if errorlevel 1 goto :failed
)

echo.
echo 后台/登录: http://127.0.0.1:5189/login
echo 后台订单:   http://127.0.0.1:5189/admin/orders
echo 仓库端:     http://127.0.0.1:5189/warehouse
echo.
echo 后台账号: admin@e2e.test
echo 后台密码: OulingTMS2026!
echo 仓库账号: ucrstore01@e2e.test
echo 仓库密码: OulingTMS2026!
echo.

call npm run dev:win
goto :end

:failed
echo.
echo [失败] 启动失败，请把本窗口错误截图发给开发人员。
pause
exit /b 1

:end
pause

