#!/bin/zsh
# GeoAgentic launcher: builds the cursor overlay if needed, then serves the UI.
cd "$(dirname "$0")"
[ overlay -nt overlay.swift ] || swiftc -O overlay.swift -o overlay
pgrep -x ollama >/dev/null || (ollama serve >/dev/null 2>&1 &)
open http://localhost:8000
exec python3 server.py 8000
