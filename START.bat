@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VEXA MEN — магазин

set "NODE="
where node >nul 2>nul && set "NODE=node"
if defined NODE goto run
if exist "runtime\node\node.exe" set "NODE=runtime\node\node.exe"
if defined NODE goto run

echo Node.js не найден. Скачиваю переносную версию, это нужно один раз...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $v='v22.12.0'; New-Item -ItemType Directory -Force runtime | Out-Null; Invoke-WebRequest ('https://nodejs.org/dist/'+$v+'/node-'+$v+'-win-x64.zip') -OutFile 'runtime\node.zip' -UseBasicParsing; Expand-Archive 'runtime\node.zip' 'runtime' -Force; Rename-Item ('runtime\node-'+$v+'-win-x64') 'node'; Remove-Item 'runtime\node.zip'"
if exist "runtime\node\node.exe" set "NODE=runtime\node\node.exe"
if defined NODE goto run
echo.
echo Не удалось скачать Node.js. Установите его с сайта https://nodejs.org и запустите этот файл снова.
pause
exit /b 1

:run
rem Node.js не видит сертификаты Windows. Если антивирус проверяет HTTPS, без этого нет связи с Telegram.
if not exist runtime mkdir runtime
powershell -NoProfile -ExecutionPolicy Bypass -Command "$sb=New-Object Text.StringBuilder; Get-ChildItem Cert:\LocalMachine\Root,Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | ForEach-Object { [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----'); [void]$sb.AppendLine([Convert]::ToBase64String($_.RawData,'InsertLineBreaks')); [void]$sb.AppendLine('-----END CERTIFICATE-----') }; [IO.File]::WriteAllText((Join-Path (Get-Location) 'runtime\win-ca.pem'),$sb.ToString())" >nul 2>nul
if exist "runtime\win-ca.pem" set "NODE_EXTRA_CA_CERTS=%~dp0runtime\win-ca.pem"
"%NODE%" launcher.js
echo.
pause
