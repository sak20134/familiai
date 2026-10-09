#!/usr/bin/env bash
# Pulls every reference repo for Family AI straight from GitHub (latest version).
# Usage: bash scripts/get-resources.sh   (run again any time to update to the latest)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources
REPOS=(
  livekit/agents-js
  livekit-examples/agent-starter-react-native
  pipecat-ai/pipecat
  dscripka/openWakeWord
  moeru-ai/airi
  Open-LLM-VTuber/Open-LLM-VTuber
  pixiv/three-vrm
  trycua/cua
  browser-use/browser-use
  mem0ai/mem0
  letta-ai/letta
  modelcontextprotocol/typescript-sdk
  modelcontextprotocol/servers
  better-auth/better-auth
  vercel/chatbot
  assistant-ui/assistant-ui
  stackblitz-labs/bolt.diy
  actualbudget/actual
  obytes/react-native-template-obytes
  AnubhavChaturvedi-GitHub/jarvis-ai-assistant
  ayangweb/BongoCat
  SeakMengs/WindowPet
  fivestones/family-organizer
  sak20134/kin-agent
)
for r in "${REPOS[@]}"; do
  d="resources/${r##*/}"
  if [ -d "$d/.git" ]; then
    echo "Updating $r"; git -C "$d" pull --ff-only --depth 1 || true
  else
    echo "Cloning  $r"; git clone --depth 1 "https://github.com/$r" "$d"
  fi
done
echo "Done. Repos are in ./resources"
