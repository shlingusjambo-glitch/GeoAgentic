# GeoAgentic

Local computer-use agent on Ollama. Text-first: it reads the screen via the accessibility tree
(`screen_read`) and Chrome DOM (`browser_read`), and only takes a screenshot (described by a vision
model) when text isn't enough. It drives the Mac with its own visible cursor: apps are opened in the
background and input is delivered to that app's process (Accessibility + per-pid events), so your real
mouse and keyboard are never touched and you can keep working while it runs.

```bash
./run.sh
```

This starts the server and the browser UI, and puts a cursor icon in the menu bar: click it anywhere to hand the
agent a task, watch what it is doing, and see "Task complete" when it is done, without leaving what you are working
on. The agent and you share the Mac: its input goes only to the app it opened, its cursor is drawn only over that
app, and if you are actively using that same app it waits until you pause.

Requirements: macOS, Xcode CLT (`swiftc`), Ollama running with a tool-capable model (e.g. `qwen2.5`),
optionally `moondream` for screenshots. Grant **Accessibility** (and **Screen Recording** for
screenshots) to the terminal you launch from. For `browser_read`, enable Chrome
*View > Developer > Allow JavaScript from Apple Events*.

Files: `server.py` (agent loop + tools), `overlay.swift` (cursor overlay, input injection, AX tree),
`menubar.swift` (menu bar companion), `index.html` (browser UI), `static/` (cursor images).
