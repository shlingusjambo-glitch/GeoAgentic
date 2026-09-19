// GeoAgentic menu bar companion: a status-bar icon that opens a small chat panel from anywhere, so the agent can be
// given work without the browser UI. Talks to server.py on localhost:8000 (same API as index.html).
import AppKit
import Foundation

let SERVER = "http://localhost:8000"
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// ---------- state ----------
enum Phase { case idle, working, done, failed }
var phase = Phase.idle
var history: [[String: Any]] = []          // chat messages sent to the server
var activity = ""                          // what the agent is doing right now
var lastResult = ""
var task: URLSessionDataTask? = nil
var lineBuffer = ""

// ---------- status item ----------
let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
func icon(for p: Phase) -> NSImage? {
    let name: String
    switch p { case .idle: name = "cursorarrow.rays"; case .working: name = "cursorarrow.motionlines"; case .done: name = "checkmark.circle.fill"; case .failed: name = "exclamationmark.circle" }
    let img = NSImage(systemSymbolName: name, accessibilityDescription: "GeoAgentic")
    img?.isTemplate = true
    return img
}
func setPhase(_ p: Phase) {
    phase = p
    statusItem.button?.image = icon(for: p)
    statusItem.button?.toolTip = p == .working ? "GeoAgentic: " + activity : "GeoAgentic"
    refresh()
}

// ---------- panel ----------
let popover = NSPopover()
popover.behavior = .transient
popover.animates = true
let root = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 300))

let field = NSTextField(frame: NSRect(x: 16, y: 252, width: 380, height: 32))
field.placeholderString = "What can I help you with today?"
field.font = NSFont.systemFont(ofSize: 17)
field.isBezeled = false; field.drawsBackground = false; field.focusRingType = .none
field.cell?.usesSingleLineMode = true; field.cell?.wraps = false; field.cell?.isScrollable = true

let sendBtn = NSButton(frame: NSRect(x: 462, y: 250, width: 42, height: 36))
sendBtn.bezelStyle = .rounded; sendBtn.title = ""
sendBtn.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "Send")
sendBtn.keyEquivalent = "\r"

let stopBtn = NSButton(frame: NSRect(x: 412, y: 250, width: 42, height: 36))
stopBtn.bezelStyle = .rounded; stopBtn.title = ""
stopBtn.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop"); stopBtn.isHidden = true

let modelPopup = NSPopUpButton(frame: NSRect(x: 16, y: 212, width: 220, height: 26), pullsDown: false)
modelPopup.font = NSFont.systemFont(ofSize: 12)
let reasoningPopup = NSPopUpButton(frame: NSRect(x: 244, y: 212, width: 150, height: 26), pullsDown: false)
reasoningPopup.addItems(withTitles: ["none", "low", "medium", "high", "extra", "max", "ultra"].map { "reasoning: " + $0 })
reasoningPopup.font = NSFont.systemFont(ofSize: 12)
let newChatBtn = NSButton(frame: NSRect(x: 402, y: 212, width: 102, height: 26))
newChatBtn.bezelStyle = .rounded; newChatBtn.title = "New chat"; newChatBtn.font = NSFont.systemFont(ofSize: 12)

let statusLabel = NSTextField(labelWithString: "Idle")
statusLabel.frame = NSRect(x: 16, y: 180, width: 488, height: 20)
statusLabel.font = NSFont.boldSystemFont(ofSize: 13)

let logScroll = NSScrollView(frame: NSRect(x: 16, y: 12, width: 488, height: 160))
let logView = NSTextView(frame: logScroll.bounds)
logView.isEditable = false; logView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
logView.textContainerInset = NSSize(width: 6, height: 6)
logScroll.documentView = logView; logScroll.hasVerticalScroller = true; logScroll.borderType = .bezelBorder

for v in [field, sendBtn, stopBtn, modelPopup, reasoningPopup, newChatBtn, statusLabel, logScroll] as [NSView] { root.addSubview(v) }
let vc = NSViewController(); vc.view = root; popover.contentViewController = vc

var logLines: [String] = []
func log(_ s: String) {
    logLines.append(s); if logLines.count > 200 { logLines.removeFirst() }
    logView.string = logLines.joined(separator: "\n")
    logView.scrollToEndOfDocument(nil)
}
func refresh() {
    switch phase {
    case .idle: statusLabel.stringValue = "Idle"; statusLabel.textColor = .secondaryLabelColor
    case .working: statusLabel.stringValue = "Working: " + activity; statusLabel.textColor = .labelColor
    case .done: statusLabel.stringValue = "Task complete"; statusLabel.textColor = .systemGreen
    case .failed: statusLabel.stringValue = "Stopped"; statusLabel.textColor = .systemOrange
    }
    stopBtn.isHidden = phase != .working
    sendBtn.isEnabled = phase != .working
}

// ---------- models ----------
func loadModels() {
    guard let url = URL(string: SERVER + "/api/models") else { return }
    URLSession.shared.dataTask(with: url) { data, _, _ in
        guard let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let models = j["models"] as? [[String: Any]] else { return }
        let names = models.compactMap { $0["name"] as? String }
        DispatchQueue.main.async {
            modelPopup.removeAllItems(); modelPopup.addItems(withTitles: names)
            if let saved = UserDefaults.standard.string(forKey: "model"), names.contains(saved) { modelPopup.selectItem(withTitle: saved) }
        }
    }.resume()
}

// ---------- streaming client ----------
final class Stream: NSObject, URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lineBuffer += String(decoding: data, as: UTF8.self)
        while let nl = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<nl]); lineBuffer = String(lineBuffer[lineBuffer.index(after: nl)...])
            guard let d = line.data(using: .utf8), let ev = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            DispatchQueue.main.async { handle(ev) }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async {
            if phase == .working { setPhase(error == nil ? .done : .failed) }
            if let e = error, (e as NSError).code != NSURLErrorCancelled { log("connection error: \(e.localizedDescription) — is ./run.sh running?") }
        }
    }
}
let streamDelegate = Stream()
let session = URLSession(configuration: .default, delegate: streamDelegate, delegateQueue: nil)

func handle(_ ev: [String: Any]) {
    switch ev["type"] as? String {
    case "tool":
        let name = ev["name"] as? String ?? ""
        let args = (ev["args"] as? [String: Any])?.values.compactMap { $0 as? String }.joined(separator: " ") ?? ""
        activity = (name + " " + args).trimmingCharacters(in: .whitespaces)
        log("▸ " + activity); setPhase(.working)
    case "result":
        let r = (ev["result"] as? String ?? "").split(separator: "\n").first.map(String.init) ?? ""
        log("   " + r.prefix(120))
    case "text":
        let t = ev["content"] as? String ?? ""
        lastResult = t; history.append(["role": "assistant", "content": t]); log("● " + t)
    case "thinking":
        activity = "thinking…"; refresh()
    case "done":
        setPhase(.done); activity = ""
    default: break
    }
}

func submit() {
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, phase != .working, let url = URL(string: SERVER + "/") else { return }
    field.stringValue = ""; logLines = []; log("› " + text)
    history.append(["role": "user", "content": text])
    activity = "starting"; setPhase(.working)
    let model = modelPopup.titleOfSelectedItem ?? ""
    UserDefaults.standard.set(model, forKey: "model")
    let reasoning = (reasoningPopup.titleOfSelectedItem ?? "reasoning: none").replacingOccurrences(of: "reasoning: ", with: "")
    let body: [String: Any] = ["messages": history, "cfg": ["model": model, "reasoning": reasoning, "tools": "compact", "vision_model": "moondream"]]
    var req = URLRequest(url: url); req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    req.timeoutInterval = 3600
    task = session.dataTask(with: req); task?.resume()
}

final class Actions: NSObject {
    @objc func send(_ s: Any?) { submit() }
    @objc func stop(_ s: Any?) { task?.cancel(); setPhase(.failed); log("stopped") }
    @objc func newChat(_ s: Any?) { history = []; logLines = []; logView.string = ""; setPhase(.idle) }
    @objc func toggle(_ s: Any?) {
        if popover.isShown { popover.performClose(nil); return }
        guard let b = statusItem.button else { return }
        refresh()
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
        app.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeFirstResponder(field)
    }
}
let actions = Actions()
sendBtn.target = actions; sendBtn.action = #selector(Actions.send(_:))
stopBtn.target = actions; stopBtn.action = #selector(Actions.stop(_:))
newChatBtn.target = actions; newChatBtn.action = #selector(Actions.newChat(_:))
statusItem.button?.target = actions; statusItem.button?.action = #selector(Actions.toggle(_:))

setPhase(.idle)
loadModels()
app.run()
