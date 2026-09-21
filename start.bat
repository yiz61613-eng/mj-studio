@echo off
chcp 65001 >nul
title RB 素材服务
echo ============================================
echo   RB 素材服务 (http://localhost:8899)
echo   请保持本窗口开启；画布操作在浏览器中进行
echo ============================================
node "%~dp0asset-server.js"
pause
