#!/bin/sh
# Installs (or updates) the Family AI desktop bot on macOS or Linux and adds the `familyai` command.
#
#   curl -fsSL https://raw.githubusercontent.com/sak20134/familiai/feat/desktop-bot/apps/desktop-bot/scripts/install.sh | sh
#
# It only touches ~/familiai (the app) and ~/.local/bin/familyai (the command). No sudo needed.
# Needs Node.js 22 or newer (nodejs.org, or your package manager).
set -eu

HOME_DIR="${FAMILYAI_DIR:-$HOME/familiai}"
BRANCH="${FAMILYAI_BRANCH:-feat/desktop-bot}"
ZIP="https://github.com/sak20134/familiai/archive/refs/heads/$BRANCH.tar.gz"
BIN_DIR="$HOME/.local/bin"

say() { printf '  %s\n' "$*"; }
fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

printf '\n  Family AI desktop bot\n\n'

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get version 22 or newer from https://nodejs.org (or: brew install node / sudo apt install nodejs npm), then run this again."
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || fail "Node.js $(node -v) is too old. Install version 22 or newer from https://nodejs.org, then run this again."
command -v npm >/dev/null 2>&1 || fail "npm is missing. Install it with Node.js from https://nodejs.org."

if command -v git >/dev/null 2>&1 && [ -d "$HOME_DIR/.git" ]; then
  say "Updating with git..."
  git -C "$HOME_DIR" fetch origin "$BRANCH"
  git -C "$HOME_DIR" checkout "$BRANCH"
  git -C "$HOME_DIR" pull --ff-only origin "$BRANCH"
else
  command -v curl >/dev/null 2>&1 || fail "curl is missing. Install curl or git, then run this again."
  say "Downloading the latest version into $HOME_DIR ..."
  mkdir -p "$HOME_DIR"
  # Your settings live in ~/.familyai and are never touched by an update.
  curl -fsSL "$ZIP" | tar -xz --strip-components=1 -C "$HOME_DIR"
fi

APP="$HOME_DIR/apps/desktop-bot"
cd "$APP"
say "Installing (the first time takes a few minutes)..."
npm ci --no-audit --no-fund
node scripts/build.mjs

mkdir -p "$BIN_DIR"
chmod +x "$APP/bin/familyai.mjs"
ln -sf "$APP/bin/familyai.mjs" "$BIN_DIR/familyai"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH to use the familyai command, e.g.:"
     say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile && . ~/.profile" ;;
esac

if [ "$(uname)" = "Linux" ] && ! command -v xdotool >/dev/null 2>&1; then
  say "Optional: install xdotool so take-over mode can type (sudo apt install xdotool)."
fi
if [ "$(uname)" = "Darwin" ]; then
  say "macOS: take-over typing needs Accessibility permission for the bot (System Settings > Privacy & Security > Accessibility)."
fi

printf '\n'
say "Installed. Start it with:  familyai start"
say "Check the setup with:      familyai doctor"
printf '\n'
"$BIN_DIR/familyai" start || true
