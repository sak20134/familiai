@echo off
rem Stream Copilot launcher for Windows. Double-click to download (or update) and start it.
rem It only touches the familiai folder in your user folder. Your .env file is never changed.
setlocal
title Stream Copilot
set "HOME_DIR=%USERPROFILE%\familiai"
set "BRANCH=feat/desktop-bot"
set "ZIP=https://github.com/sak20134/familiai/archive/refs/heads/feat/desktop-bot.zip"

echo.
echo  Stream Copilot
echo  ==============
echo.

rem Node.js: use an installed one (version 22 or newer) if there is one. Otherwise download the
rem official portable Node.js into the familiai folder. Nothing is installed on Windows itself, no
rem admin rights are needed, and the file is checked against nodejs.org's published checksum first.
set "NODE_VER=v24.21.0"
set "NODE_ZIP=node-v24.21.0-win-x64.zip"
set "NODE_SHA=158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"
set "NODE_DIR=%HOME_DIR%\.node"

where node >nul 2>nul || goto :portable
for /f "tokens=1 delims=." %%v in ('node -v') do set "NODEV=%%v"
set "NODEV=%NODEV:v=%"
if %NODEV% GEQ 22 goto :node_ready

:portable
if exist "%NODE_DIR%\node.exe" goto :use_portable
where curl >nul 2>nul || goto :no_tools
where tar >nul 2>nul || goto :no_tools
echo  Node.js is not installed, so downloading the official portable version:
echo  %NODE_ZIP% from nodejs.org, about 36 MB. Nothing is installed on Windows itself.
if not exist "%NODE_DIR%" mkdir "%NODE_DIR%"
curl -fsSL -o "%TEMP%\%NODE_ZIP%" "https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%" || goto :fail
set "GOT="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%TEMP%\%NODE_ZIP%" SHA256') do if not defined GOT set "GOT=%%h"
set "GOT=%GOT: =%"
if /i not "%GOT%"=="%NODE_SHA%" goto :bad_hash
echo  Checksum matches nodejs.org. Unpacking...
tar -xf "%TEMP%\%NODE_ZIP%" --strip-components=1 -C "%NODE_DIR%" || goto :fail
del "%TEMP%\%NODE_ZIP%" >nul 2>nul

:use_portable
set "PATH=%NODE_DIR%;%PATH%"

:node_ready

rem Git is optional: with a git copy we update with git, otherwise we download a zip using the
rem curl and tar programs built into Windows 10 and 11. Your .env and data folders are kept either way.
set "USE_GIT=0"
where git >nul 2>nul && if exist "%HOME_DIR%\.git" set "USE_GIT=1"

if "%USE_GIT%"=="1" (
  echo  Updating to the latest version...
  pushd "%HOME_DIR%"
  git fetch origin %BRANCH% || goto :fail_pop
  git checkout %BRANCH% || goto :fail_pop
  git pull --ff-only origin %BRANCH% || goto :fail_pop
  goto :install
)

where curl >nul 2>nul || goto :no_tools
where tar >nul 2>nul || goto :no_tools
echo  Downloading the latest Stream Copilot into %HOME_DIR% ...
if not exist "%HOME_DIR%" mkdir "%HOME_DIR%"
curl -fsSL -o "%TEMP%\familiai.zip" "%ZIP%" || goto :fail
tar -xf "%TEMP%\familiai.zip" --strip-components=1 -C "%HOME_DIR%" || goto :fail
del "%TEMP%\familiai.zip" >nul 2>nul
pushd "%HOME_DIR%"

:install

echo.
echo  Installing (the first time takes a minute)...
call npm install --no-audit --no-fund || goto :fail_pop

if not exist "apps\stream-copilot\.env" (
  copy "apps\stream-copilot\.env.example" "apps\stream-copilot\.env" >nul
  echo.
  echo  Made a settings file for you: %HOME_DIR%\apps\stream-copilot\.env
  echo  Open it in Notepad to connect OBS and Twitch. It works without them too.
)

echo.
call npm run stream
popd
echo.
echo  Stream Copilot stopped.
pause
exit /b 0

:bad_hash
del "%TEMP%\%NODE_ZIP%" >nul 2>nul
echo  The Node.js download did not match nodejs.org's official checksum, so it was NOT used.
echo  Check your internet connection and try again.
goto :fail

:no_tools
echo  This Windows is missing curl or tar, which come with Windows 10 and 11.
echo  Install Git from https://git-scm.com/download/win instead, then double-click this again.
goto :fail

:fail_pop
popd
:fail
echo.
echo  Something went wrong. Read the message above, fix it, then double-click again.
pause
exit /b 1
