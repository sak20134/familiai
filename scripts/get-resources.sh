#!/usr/bin/env bash
# Pulls every reference repo listed in resources.tsv straight from GitHub (latest version).
# Usage: bash scripts/get-resources.sh      (run again any time to update)
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources
while IFS=$'\t' read -r group repo; do
  [ -z "${repo:-}" ] && continue
  d="resources/${repo##*/}"
  [ -d "$d" ] && [ ! -d "$d/.git" ] && d="resources/${repo%%/*}-${repo##*/}"
  if [ -d "$d/.git" ]; then
    echo "Updating $repo"; git -C "$d" pull -q --ff-only --depth 1 || echo "  (could not update $repo)"
  else
    echo "Cloning  $repo [$group]"; git clone -q --depth 1 --single-branch --filter=blob:limit=2m "https://github.com/$repo" "$d" || echo "  (could not clone $repo)"
  fi
done < resources.tsv
echo "Done. Repos are in ./resources"
