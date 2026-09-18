# GeoAgentic

Local computer-use agent on Ollama. Text-first: it reads the screen via the accessibility tree
(`screen_read`) and Chrome DOM (`browser_read`), and only takes a screenshot (described by a vision
model) when text isn't enough. It drives the Mac with its own visible cursor: apps are opened in the
background and input is delivered to that app's process (Accessibility + per-pid events), so your real
mouse and keyboard are never touched and you can keep working while it runs.

```bash
./run.sh
```

Requirements: macOS, Xcode CLT (`swiftc`), Ollama running with a tool-capable model (e.g. `qwen2.5`),
optionally `moondream` for screenshots. Grant **Accessibility** (and **Screen Recording** for
screenshots) to the terminal you launch from. For `browser_read`, enable Chrome
*View > Developer > Allow JavaScript from Apple Events*.

Files: `server.py` (agent loop + tools), `overlay.swift` (cursor overlay, input injection, AX tree),
`index.html` (UI), `static/` (cursor images).
