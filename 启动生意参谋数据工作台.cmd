@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 请在浏览器打开 http://127.0.0.1:5177
echo 首次使用先在此目录运行 npm ci。按 Ctrl+C 停止服务。
npm start
