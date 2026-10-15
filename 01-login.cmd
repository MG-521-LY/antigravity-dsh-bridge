@echo off
cd /d "%~dp0"
"%~dp0bin\cli-proxy-api.exe" -config "%~dp0config.yaml" -antigravity-login
echo.
pause
