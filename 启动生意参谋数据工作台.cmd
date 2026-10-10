@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "if(Number(process.versions.node.split('.')[0])<20)process.exit(1)"
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_node
where python >nul 2>nul
if errorlevel 1 goto missing_python
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 goto missing_python
if not exist node_modules\chart.js\package.json goto install_dependencies
if not exist node_modules\lucide\package.json goto install_dependencies
goto launch
:install_dependencies
echo First run: installing dependencies. Internet access is required.
call npm ci
if errorlevel 1 goto install_failed
:launch
if not defined PORT set "PORT=5177"
echo Open in your browser: http://127.0.0.1:%PORT%
echo Keep this window open. Press Ctrl+C to stop. See the homepage import guide.
node server.mjs
if errorlevel 1 goto launch_failed
goto finished
:missing_node
echo [ERROR] Node.js 20+ and npm are required. Install them and reopen this window.
goto failed
:missing_python
echo [ERROR] Python 3.10+ is required. Enable Add Python to PATH during setup.
goto failed
:install_failed
echo [ERROR] Dependency installation failed. Check your network and npm errors above.
goto failed
:launch_failed
echo [ERROR] Server failed. See details above. Close the old server or change PORT if occupied.
:failed
pause
exit /b 1
:finished
pause
exit /b 0
