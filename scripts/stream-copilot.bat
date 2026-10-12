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
