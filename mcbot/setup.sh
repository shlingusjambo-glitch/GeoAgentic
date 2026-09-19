#!/bin/zsh
# Installs a private Node.js (no sudo, inside the repo) and the Mineflayer bot dependencies.
set -e
cd "$(dirname "$0")/.."
if [ ! -x deps/node/bin/node ]; then
  mkdir -p deps && cd deps
  arch=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
  curl -sL "https://nodejs.org/dist/v22.11.0/node-v22.11.0-darwin-$arch.tar.gz" | tar -xz
  mv "node-v22.11.0-darwin-$arch" node && cd ..
fi
cd mcbot && PATH="$PWD/../deps/node/bin:$PATH" npm install --silent
echo "mcbot ready: in Minecraft press Escape > Open to LAN > Start LAN World, then ask the agent to play."
