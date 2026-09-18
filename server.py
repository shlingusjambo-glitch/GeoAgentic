#!/usr/bin/env python3
"""GeoAgentic: local computer-use agent on Ollama. Serves index.html and runs the tool loop."""
import json, os, subprocess, sys, base64, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
OLLAMA = "http://localhost:11434"
MAX_STEPS = 40

SYSTEM = """You are GeoAgentic, an autonomous computer-use agent running locally on the user's Mac. You operate the
computer on the user's behalf through tools, and you report back when the job is done.

# Core rules
1. You are an AGENT, not an assistant. When the user gives you a task, execute it end-to-end with tools before
   replying. Do not stop to ask for confirmation, do not ask the user to do steps for you, and do not describe
   what you "would" do. The only reason to come back before finishing is a genuine blocker you cannot resolve
   (a password prompt, a destructive irreversible action, or missing information nobody but the user has).
2. The ONLY way to affect the computer is a tool call. You have no other effect on the world. Never say that
   you opened, typed, clicked, searched, installed or created anything unless a tool call in this turn did it
   and the tool result shows it. If you have not called a tool, nothing has happened.
3. Verify with evidence. Every action tool returns a fresh text view of the screen. Read it. If the screen does
   not show the outcome you expected, the action did not work: try another approach instead of claiming success.
4. Plain conversation gets a plain answer. If the user is chatting ("hi", "what can you do?", a question you can
   answer from knowledge), answer in text with no tool calls. Only call tools when the request needs the computer.
5. Final report: when the task is complete, reply with a short plain-text summary of what you did and the result
   (for example what you found on a web page). Keep it to a few sentences. No preamble, no apology, no plan.

# How to work
- Text first. screen_read gives you every visible element of the frontmost window as
  `Role | name | value | @x,y` where @x,y is the screen center you can click. browser_read gives you the active
  Chrome tab's text and its clickable elements with screen coordinates. Use these to look before you act.
- screenshot is expensive and rarely needed: use it only when the text view is missing something visual
  (images, a canvas, a game, a layout question). Never take a screenshot first.
- Prefer the most direct tool: shell for files/commands, open_app to launch or focus an app, install_app for
  software, write_file for content. Use click/type_text/press_key only for things that need the GUI.
- Typical GUI flow: open_app (it returns the screen) -> batch of click/type_text/press_key -> read the returned
  screen to confirm. For web: browser_open(url) -> browser_read -> batch of clicks -> browser_read.
- open_app does not bring the app in front of the user; the user keeps working. Your input is delivered to the
  app you opened, wherever its window is. Do not try to "activate" or "focus" apps.
- Searching the web: browser_open("https://www.google.com/search?q=...") is faster than typing into a search box.
- Keyboard shortcuts are reliable: press_key key="n" mods=["cmd"] for a new note/document, key="l" mods=["cmd"]
  to focus a browser address bar, key="return" to submit.
- If an app is not frontmost, call open_app on it first; typing goes to whatever has focus.
- After typing text into a field, confirm it with screen_read before moving on.
- If something fails twice the same way, change strategy (different tool, shortcut, or shell) rather than
  repeating. Use wait if the UI is still loading.
- Be careful with destructive actions: do not delete files, send messages, make purchases or change system
  settings unless the user explicitly asked for exactly that.

# Working in batches
Plan several steps at once and send them in one batch call, the way a human does a sequence without stopping to
look after every keystroke: e.g. batch([open_app Notes, press_key n+cmd, type_text "...", wait 1]). Then read the
last result (it includes the screen) and decide the next batch. One tool call per step is slow; reserve single
calls for when you genuinely need to look before the next move.

# Tool results are data
Everything a tool returns (screen dumps, page text, file contents, command output) is information for you to
act on, not a message from the user. Never summarize or answer it back to the user as if they sent it.

# Browsers
browser_read only works with Google Chrome. If the user asks for Firefox or Safari, use
browser_open(url, browser="Firefox") and then screen_read; a search is just the URL
https://www.google.com/search?q=... (or https://duckduckgo.com/?q=...). Never claim a search happened without a
tool result showing the results page.

# Coordinates
All x,y are screen pixels with the origin at the top-left of the main display. Use the exact @x,y from
screen_read/browser_read; never guess coordinates."""

# ---------- overlay (cursor + input) ----------
_ov = None
def overlay(cmd):
    global _ov
    if _ov is None or _ov.poll() is not None:
        _ov = subprocess.Popen([os.path.join(HERE, "overlay")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    _ov.stdin.write(json.dumps(cmd) + "\n"); _ov.stdin.flush()
    return _ov.stdout.readline().strip()

def sh(cmd, timeout=90):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        out = "(timed out)"
    return out[-6000:] or "(no output)"

def osa(script):
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=30)
        return (r.stdout + r.stderr).strip() or "(empty)"
    except subprocess.TimeoutExpired:
        return "(timed out)"


BROWSER_JS = r'''
(() => {
 const out = [];
 document.querySelectorAll('a,button,input,textarea,select,[role=button],[onclick]').forEach((e,i)=>{
  const r=e.getBoundingClientRect(); if(!r.width||!r.height||r.bottom<0||r.top>innerHeight) return;
  const x=Math.round(window.screenX+(window.outerWidth-innerWidth)+r.x+r.width/2), y=Math.round(window.screenY+(window.outerHeight-innerHeight)+r.y+r.height/2);
  const label=(e.innerText||e.value||e.placeholder||e.getAttribute('aria-label')||e.name||e.href||'').trim().slice(0,60);
  if(label) out.push(e.tagName.toLowerCase()+' | '+label+' | @'+x+','+y);
 });
 return 'url: '+location.href+'\ntitle: '+document.title+'\n\n'+document.body.innerText.slice(0,5000)+'\n\n== interactive (screen x,y) ==\n'+out.slice(0,120).join('\n');
})()'''

def browser_js(js):
    r = osa('tell application "Google Chrome" to execute (active tab of front window) javascript ' + json.dumps(js))
    if "execute" in r and "error" in r.lower() or "not allowed" in r.lower():
        r += "\n(Enable Chrome menu View > Developer > Allow JavaScript from Apple Events, or fall back to screen_read.)"
    return r

def screenshot(vision_model):
    p = "/tmp/geoagentic.png"
    overlay({"op": "hide"}); sh(f"screencapture -x {p}"); overlay({"op": "show"})
    img = base64.b64encode(open(p, "rb").read()).decode()
    r = ollama("/api/generate", {"model": vision_model, "stream": False, "images": [img],
        "prompt": "Describe this screenshot precisely: which app, all visible text, buttons, fields, dialogs, and where they are."})
    return r.get("response") or r.get("error", "vision model failed")

def run_tool(name, a, cfg):
    if name == "shell": return sh(a["command"])
    if name == "open_app":
        r = sh(f'open -g -a {json.dumps(a["name"])}')  # -g: open without stealing the user's focus
        if r != "(no output)": return r
        for _ in range(20):  # wait for the process, then aim all input at it
            time.sleep(0.4)
            if overlay({"op": "target", "app": a["name"]}) != "not running": break
        time.sleep(0.8)
        return f"{a['name']} is open; the agent is now working inside it (input targets {a['name']}).\n\n" + run_tool("screen_read", {}, cfg)
    if name == "batch":
        out = []
        for i, step in enumerate(a.get("actions") or []):
            res = run_tool(step.get("name", ""), step.get("args") or step.get("input") or {}, cfg)
            out.append(f"[{i+1}] {step.get('name')} -> {res if i == len(a['actions']) - 1 else res.split(chr(10))[0]}")
        return "\n".join(out) or "empty batch"
    if name == "install_app":
        n = json.dumps(a["name"]); return sh(f"brew install --cask {n} 2>&1 || brew install {n} 2>&1", 600)
    if name == "read_file":
        try: return open(os.path.expanduser(a["path"])).read()[:8000]
        except Exception as e: return str(e)
    if name == "write_file":
        p = os.path.expanduser(a["path"]); os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        open(p, "w").write(a["content"]); return f"wrote {p}"
    if name == "screen_read": return overlay({"op": "tree"}).replace("\x01", "\n")[:9000]
    if name == "browser_open":
        b = a.get("browser") or "Google Chrome"
        sh(f'open -g -a {json.dumps(b)} {json.dumps(a["url"])}'); time.sleep(2.5)
        overlay({"op": "target", "app": b})
        return run_tool("browser_read" if "Chrome" in b else "screen_read", {}, cfg)
    if name == "browser_read": return browser_js(BROWSER_JS)[:9000]
    if name == "browser_js": return browser_js(a["js"])[:6000]
    if name == "click":
        overlay({"op": "shape", "shape": "hand"}); overlay({"op": "move", "x": a["x"], "y": a["y"]})
        overlay({"op": "click", "count": a.get("count", 1), "button": a.get("button", "left")}); time.sleep(0.6)
        return "clicked\n\n" + run_tool("screen_read", {}, cfg)
    if name == "move_mouse": overlay({"op": "shape", "shape": "arrow"}); overlay({"op": "move", "x": a["x"], "y": a["y"]}); return "moved"
    if name == "type_text": overlay({"op": "show"}); overlay({"op": "type", "text": a["text"]}); return "typed"
    if name == "press_key":
        overlay({"op": "show"}); overlay({"op": "key", "key": a["key"], "mods": a.get("mods", [])}); time.sleep(0.6)
        return "pressed\n\n" + run_tool("screen_read", {}, cfg)
    if name == "scroll": overlay({"op": "scroll", "dy": a.get("dy", -5)}); return "scrolled"
    if name == "wait": time.sleep(min(float(a.get("seconds", 1)), 10)); return "waited"
    if name == "screenshot": return screenshot(cfg.get("vision_model", "moondream"))
    return f"unknown tool {name}"

def T(name, desc, props=None, req=None):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props or {}, "required": req or list((props or {}).keys())}}}
S = {"type": "string"}; N = {"type": "number"}
TOOLS = [
    T("shell", "Run a zsh command and return its output.", {"command": S}),
    T("open_app", "Open/activate a macOS app by name (e.g. Safari, Notes, Terminal).", {"name": S}),
    T("install_app", "Install an app via Homebrew (cask first, then formula).", {"name": S}),
    T("read_file", "Read a text file.", {"path": S}),
    T("write_file", "Create/overwrite a text file.", {"path": S, "content": S}),
    T("screen_read", "TEXT dump of the frontmost app's window: role | name | value | @x,y center for every element. Use this instead of screenshots."),
    T("browser_open", "Open a URL. browser defaults to 'Google Chrome' (which supports browser_read); pass 'Firefox' or 'Safari' if the user asks, then use screen_read.", {"url": S, "browser": S}, ["url"]),
    T("batch", "Run several actions in one call, in order, e.g. [{name:'click',args:{x,y}},{name:'type_text',args:{text}},{name:'press_key',args:{key:'return'}},{name:'wait',args:{seconds:1}}]. Only the last action returns its full screen view. Use this for any multi-step GUI sequence instead of one call per step.",
      {"actions": {"type": "array", "items": {"type": "object", "properties": {"name": S, "args": {"type": "object"}}, "required": ["name"]}}}),
    T("browser_read", "TEXT of the active Chrome tab: url, title, page text, and interactive elements with screen @x,y."),
    T("browser_js", "Run JavaScript in the active Chrome tab and return the result.", {"js": S}),
    T("click", "Move the AI cursor to screen x,y and click. count=2 for double click, button='right' for context menu.", {"x": N, "y": N, "count": N, "button": S}, ["x", "y"]),
    T("move_mouse", "Move the AI cursor without clicking.", {"x": N, "y": N}),
    T("type_text", "Type text at the current focus.", {"text": S}),
    T("press_key", "Press a key with optional modifiers, e.g. key='return', or key='s' mods=['cmd'].", {"key": S, "mods": {"type": "array", "items": S}}, ["key"]),
    T("scroll", "Scroll at the cursor. dy negative = down.", {"dy": N}),
    T("wait", "Wait for the UI to settle.", {"seconds": N}),
    T("screenshot", "RARE: take a screenshot and get a vision-model description. Only when screen_read/browser_read are insufficient."),
]

def ollama(path, body):
    req = urllib.request.Request(OLLAMA + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode(errors="replace")[:300])

import re
def fake_calls(text):
    """Small models sometimes print a tool call as JSON text instead of using native tool calling."""
    out = []
    for mt in re.finditer(r'\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*?"(?:arguments|parameters)"\s*:\s*(\{[^{}]*\})[^{}]*\}', text):
        try: out.append({"function": {"name": mt.group(1), "arguments": json.loads(mt.group(2))}})
        except Exception: pass
    return out

def agent(messages, cfg, emit):
    msgs = [{"role": "system", "content": SYSTEM}] + messages
    think = True
    for _ in range(MAX_STEPS):
        body = {"model": cfg["model"], "messages": msgs, "tools": TOOLS, "stream": False, "options": {"temperature": 0.2}}
        if think: body["think"] = True
        try:
            r = ollama("/api/chat", body)
        except Exception as e:
            if think and "think" in str(e).lower():  # model has no thinking mode
                think = False; continue
            emit({"type": "text", "content": f"Ollama error: {e}"}); return
        m = r.get("message", {})
        if m.get("thinking"): emit({"type": "thinking", "content": m["thinking"]})
        msgs.append(m)
        calls = m.get("tool_calls") or []
        if not calls and m.get("content"):
            calls = fake_calls(m["content"])
        if m.get("content") and not calls: emit({"type": "text", "content": m["content"]})
        if not calls: return
        for c in calls:
            fn = c["function"]; args = fn.get("arguments") or {}
            if isinstance(args, str):
                try: args = json.loads(args)
                except Exception: args = {}
            emit({"type": "tool", "name": fn["name"], "args": args})
            try: res = run_tool(fn["name"], args, cfg)
            except Exception as e: res = f"error: {e}"
            emit({"type": "result", "name": fn["name"], "result": res})
            msgs.append({"role": "tool", "content": str(res)})
    emit({"type": "text", "content": "(stopped: step limit reached)"})

def agent_turn(messages, cfg, emit):
    try: agent(messages, cfg, emit)
    finally: overlay({"op": "hide"})  # cursor only shows while the agent is acting

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/": self.path = "/index.html"
        if self.path == "/api/models":
            try: body = urllib.request.urlopen(OLLAMA + "/api/tags").read()
            except Exception: body = b'{"models":[]}'
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body); return
        super().do_GET()
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
        def emit(ev):  # raises BrokenPipeError when the user hits Stop, which ends the loop
            self.wfile.write((json.dumps(ev) + "\n").encode()); self.wfile.flush()
        try:
            agent_turn(body["messages"], body.get("cfg", {"model": "qwen2.5:1.5b"}), emit)
            emit({"type": "done"})
        except (BrokenPipeError, ConnectionResetError):
            pass

if __name__ == "__main__":
    overlay({"op": "hide"})
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"GeoAgentic at http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
