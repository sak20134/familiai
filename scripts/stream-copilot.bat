@echo off
rem Stream Copilot launcher for Windows. Double-click to download (or update) and start it.
rem It only touches the familiai folder in your user folder. Your .env file is never changed.
setlocal
title Stream Copilot
set "HOME_DIR=%USERPROFILE%\familiai"
set "BRANCH=feat/desktop-bot"
set "REPO=https://github.com/sak20134/familiai.git"

echo.
echo  Stream Copilot
echo  ==============
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo  Git is not installed. Get it from https://git-scm.com/download/win
  echo  then double-click this file again.
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Get the LTS version from https://nodejs.org
  echo  then double-click this file again.
  goto :fail
)
for /f "tokens=1 delims=." %%v in ('node -v') do set "NODEV=%%v"
set "NODEV=%NODEV:v=%"
if %NODEV% LSS 22 (
  echo  Your Node.js is too old. Install version 22 or newer from https://nodejs.org
  goto :fail
)

if exist "%HOME_DIR%\.git" (
  echo  Updating to the latest version...
  pushd "%HOME_DIR%"
  git fetch origin %BRANCH% || goto :fail_pop
  git checkout %BRANCH% || goto :fail_pop
  git pull --ff-only origin %BRANCH% || goto :fail_pop
) else (
  echo  Downloading Stream Copilot into %HOME_DIR% ...
  git clone -b %BRANCH% %REPO% "%HOME_DIR%" || goto :fail
  pushd "%HOME_DIR%"
)

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

:fail_pop
popd
:fail
echo.
echo  Something went wrong. Read the message above, fix it, then double-click again.
pause
exit /b 1
