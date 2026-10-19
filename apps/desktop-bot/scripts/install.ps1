# Installs (or updates) the Montex desktop bot on Windows and adds the `montex` command
# (the old `familyai` command keeps working too).
#
#   irm https://raw.githubusercontent.com/sak20134/familiai/feat/desktop-bot/apps/desktop-bot/scripts/install.ps1 | iex
#
# It only touches %USERPROFILE%\familiai (the app) and %LOCALAPPDATA%\FamilyAI\bin (the commands;
# the folder keeps its old name so it stays on your PATH after an update).
# No admin rights. Node.js is used if installed (22+); otherwise the official portable Node.js is
# downloaded and checked against nodejs.org's published checksum before it is used.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HomeDir = Join-Path $env:USERPROFILE 'familiai'
$Branch  = if ($env:FAMILYAI_BRANCH) { $env:FAMILYAI_BRANCH } else { 'feat/desktop-bot' }
$Zip     = "https://github.com/sak20134/familiai/archive/refs/heads/$Branch.zip"
$BinDir  = Join-Path $env:LOCALAPPDATA 'FamilyAI\bin'
$NodeVer = 'v24.21.0'
$NodeZip = "node-$NodeVer-win-x64.zip"
$NodeSha = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$NodeDir = Join-Path $HomeDir '.node'

function Say($t) { Write-Host "  $t" }
Write-Host ''
Write-Host '  Montex desktop bot' -ForegroundColor Yellow
Write-Host ''

# --- Node.js -------------------------------------------------------------------------------
$node = $null
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) {
  $major = [int](((& node -v) -replace '^v', '').Split('.')[0])
  if ($major -ge 22) { $node = $found.Source }
}
if (-not $node) {
  $portable = Join-Path $NodeDir 'node.exe'
  if (-not (Test-Path $portable)) {
    Say "Node.js 22+ is not installed, so downloading the official portable $NodeZip (about 36 MB)."
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
    $tmp = Join-Path $env:TEMP $NodeZip
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVer/$NodeZip" -OutFile $tmp
    $got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
    if ($got -ne $NodeSha) { Remove-Item $tmp -Force; throw 'The Node.js download did not match the official checksum, so it was NOT used.' }
    Say 'Checksum matches nodejs.org. Unpacking...'
    $unpack = Join-Path $env:TEMP 'familyai-node'
    if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
    Expand-Archive -Path $tmp -DestinationPath $unpack
    Copy-Item -Recurse -Force (Join-Path $unpack "node-$NodeVer-win-x64\*") $NodeDir
    Remove-Item -Recurse -Force $unpack, $tmp
  }
  $node = $portable
}
$env:PATH = "$(Split-Path $node);$env:PATH"
$npm = Join-Path (Split-Path $node) 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm' }

# --- Get the code ----------------------------------------------------------------------------
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git -and (Test-Path (Join-Path $HomeDir '.git'))) {
  Say 'Updating with git...'
  & git -C $HomeDir fetch origin $Branch
  & git -C $HomeDir checkout $Branch
  & git -C $HomeDir pull --ff-only origin $Branch
  if ($LASTEXITCODE -ne 0) { throw 'git could not update the app folder.' }
} else {
  Say "Downloading the latest version into $HomeDir ..."
  $tmpZip = Join-Path $env:TEMP 'familiai.zip'
  $tmpDir = Join-Path $env:TEMP 'familiai-src'
  Invoke-WebRequest -UseBasicParsing -Uri $Zip -OutFile $tmpZip
  if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir
  $src = Get-ChildItem $tmpDir | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
  # Copy over the old version; your settings live in %USERPROFILE%\.familyai and are not touched.
  Copy-Item -Recurse -Force (Join-Path $src.FullName '*') $HomeDir
  Remove-Item -Recurse -Force $tmpZip, $tmpDir
}

# --- Install and build ---------------------------------------------------------------------------
$App = Join-Path $HomeDir 'apps\desktop-bot'
Push-Location $App
try {
  Say 'Installing (the first time takes a few minutes)...'
  & $npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm could not install the app.' }
  # Builds the real app, named "Montex" with its own icon (no admin rights needed).
  & $npm run pack
  if ($LASTEXITCODE -ne 0) { throw 'Packaging the app failed.' }
  # Puts the bot's brain in place now, so it can think the moment it first opens.
  & $node dist/setup-brain.js
} finally { Pop-Location }

# --- The montex command (and the old familyai name) ---------------------------------------------
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cmdFile = Join-Path $BinDir 'montex.cmd'
foreach ($name in 'montex', 'familyai') {
  Set-Content -Path (Join-Path $BinDir "$name.cmd") -Encoding ASCII -Value "@echo off`r`n`"$node`" `"$App\bin\cli.mjs`" %*"
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $BinDir)) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $BinDir), 'User')
  Say "Added $BinDir to your PATH. Open a NEW terminal to use the montex command."
}
$env:PATH = "$BinDir;$env:PATH"

Write-Host ''
Say 'Installed. Start it with:  montex start'
Say 'Check the setup with:      montex doctor'
Write-Host ''
& $cmdFile start
