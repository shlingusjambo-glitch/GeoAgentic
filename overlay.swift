// GeoAgentic cursor overlay + input injection. One JSON command per line on stdin, one reply line on stdout.
// The agent never touches the user's real mouse: input is posted straight to the target app's pid
// (CGEvent.postToPid), and the visible cursor is our own floating panel.
import AppKit
import Foundation

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let dir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let arrow = NSImage(contentsOf: dir.appendingPathComponent("static/arrow.png"))!
let hand = NSImage(contentsOf: dir.appendingPathComponent("static/hand.png"))!
let hotspot: [String: CGPoint] = ["arrow": CGPoint(x: 3, y: 2), "hand": CGPoint(x: 7, y: 2)]  // tip pixel, from image top-left
let PAD: CGFloat = 20  // room around the cursor for the click ripple

let win = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 24 + PAD * 2, height: 24 + PAD * 2), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
win.level = .screenSaver
win.isOpaque = false
win.backgroundColor = .clear
win.ignoresMouseEvents = true
win.hasShadow = false
win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
win.contentView!.wantsLayer = true

let cursorLayer = CALayer()
cursorLayer.contents = arrow
cursorLayer.frame = CGRect(x: PAD, y: PAD, width: 24, height: 24)
cursorLayer.contentsGravity = .topLeft
cursorLayer.anchorPoint = CGPoint(x: 0.15, y: 0.9)  // rotate/scale around the tip
cursorLayer.position = CGPoint(x: PAD + 24 * 0.15, y: PAD + 24 * 0.9)
cursorLayer.shadowOpacity = 0.35; cursorLayer.shadowRadius = 3; cursorLayer.shadowOffset = CGSize(width: 0, height: -1)
win.contentView!.layer!.addSublayer(cursorLayer)

var shape = "arrow"
var pos = CGPoint(x: 400, y: 300)  // CG coords: top-left origin
var targetPid: pid_t = 0

func screenH() -> CGFloat { NSScreen.screens[0].frame.height }
func frame(_ secs: Double) { RunLoop.main.run(until: Date(timeIntervalSinceNow: secs)) }  // sleep that still repaints
// The cursor belongs to the app the agent is working in: it is only drawn while the target app's own window
// is the topmost thing under the tip, so it never floats over the user's other windows.
func overTarget() -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return true }
    let me = getpid(), t = pid()
    if t == 0 { return false }
    for w in list {  // front-to-back
        guard let owner = w[kCGWindowOwnerPID as String] as? pid_t, owner != me,
              (w[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        if r.contains(pos) { return owner == t }
    }
    return false
}
var showing = false
func place() {
    let hs = hotspot[shape]!
    // tip of the cursor image sits exactly on `pos`
    win.setFrameOrigin(NSPoint(x: pos.x - PAD - hs.x, y: screenH() - pos.y - PAD - 24 + hs.y))
    win.alphaValue = (showing && overTarget()) ? 1 : 0
}
// Idle wobble while the agent is active, so the cursor reads as "alive" between actions.
func wobble(_ on: Bool) {
    cursorLayer.removeAnimation(forKey: "wobble")
    guard on else { return }
    let a = CAKeyframeAnimation(keyPath: "transform.rotation.z")
    a.values = [0, 0.10, -0.08, 0.06, -0.04, 0]; a.keyTimes = [0, 0.15, 0.35, 0.55, 0.75, 1]
    a.duration = 1.6; a.repeatCount = .infinity; a.isAdditive = true
    cursorLayer.add(a, forKey: "wobble")
}
func setRotation(_ deg: CGFloat, scale: CGFloat = 1) {
    CATransaction.begin(); CATransaction.setDisableActions(true)
    cursorLayer.setAffineTransform(CGAffineTransform(rotationAngle: deg * .pi / 180).scaledBy(x: scale, y: scale))
    CATransaction.commit()
}

func pidFor(_ name: String) -> pid_t {
    let n = name.lowercased().replacingOccurrences(of: ".app", with: "")
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    // exact name / bundle name first, then a loose match ("settings" -> "System Settings", "chrome" -> "Google Chrome")
    if let a = apps.first(where: { ($0.localizedName ?? "").lowercased() == n || ($0.bundleURL?.lastPathComponent.lowercased() ?? "") == n + ".app" }) { return a.processIdentifier }
    if let a = apps.first(where: { ($0.localizedName ?? "").lowercased().contains(n) || ($0.bundleIdentifier ?? "").lowercased().hasSuffix("." + n) }) { return a.processIdentifier }
    return 0
}
func runningApps() -> String {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.localizedName }.joined(separator: ", ")
}
// One line per running app: name, front window title, frontmost marker. Cheap way to see what the user is doing.
func appsDetail() -> String {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var out: [String] = []
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
        guard let n = a.localizedName else { continue }
        let ae = AXUIElementCreateApplication(a.processIdentifier)
        var title = ""
        if let w = (ax(ae, kAXFocusedWindowAttribute) ?? ax(ae, kAXMainWindowAttribute)) { title = ax(w as! AXUIElement, kAXTitleAttribute) as? String ?? "" }
        else if let ws = ax(ae, kAXWindowsAttribute) as? [AXUIElement], let w = ws.first { title = ax(w, kAXTitleAttribute) as? String ?? "" }
        var line = n
        if !title.isEmpty && title != n { line += " — \(title)" }
        if a.processIdentifier == front { line += " (frontmost)" }
        if a.isHidden { line += " (hidden)" }
        out.append(line)
    }
    return out.joined(separator: "\u{1}")
}
// System media keys (play/pause, next, volume...) go to whatever is playing, no app targeting needed.
func mediaKey(_ name: String) -> Bool {
    let codes: [String: Int32] = ["play": 16, "pause": 16, "playpause": 16, "next": 17, "previous": 18, "prev": 18,
                                  "volume_up": 0, "volume_down": 1, "mute": 7, "brightness_up": 2, "brightness_down": 3]
    guard let k = codes[name] else { return false }
    for down in [true, false] {
        let flags: NSEvent.ModifierFlags = down ? [] : [.init(rawValue: 0xB00)]
        let data1 = Int((k << 16) | (down ? 0xA << 8 : 0xB << 8))
        if let e = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1) {
            e.cgEvent?.post(tap: .cghidEventTap)
        }
    }
    return true
}
// The agent only ever acts on the app it opened. No target -> no reads, no input, no cursor.
func pid() -> pid_t {
    if targetPid != 0, NSRunningApplication(processIdentifier: targetPid) != nil { return targetPid }
    return 0
}
func send(_ e: CGEvent?) { let p = pid(); if p != 0 { e?.postToPid(p) } }
func appEl() -> AXUIElement { AXUIElementCreateApplication(pid()) }
func focusedEl() -> AXUIElement? {
    if pid() == 0 { return nil }
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(appEl(), kAXFocusedUIElementAttribute as CFString, &v) == .success ? (v as! AXUIElement) : nil
}
// Insert text at the caret of the target app's focused element via Accessibility. Works while the app is
// in the background, where synthetic key events would be dropped. Returns false if there is no text focus.
func axInsert(_ text: String) -> Bool {
    guard let f = focusedEl() else { return false }
    return AXUIElementSetAttributeValue(f, kAXSelectedTextAttribute as CFString, text as CFString) == .success
}
// Click via Accessibility: press the element under the point, or focus it if it is a text field.
func axClick(_ p: CGPoint) -> Bool {
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(appEl(), Float(p.x), Float(p.y), &el) == .success, let e = el else { return false }
    let role = ax(e, kAXRoleAttribute) as? String ?? ""
    if ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) {
        return AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    }
    return AXUIElementPerformAction(e, kAXPressAction as CFString) == .success
}

// ---- Codex-style motion: curved flight, leans into the turn, squash on click ----
func fly(to target: CGPoint) {
    showing = true; win.orderFrontRegardless(); wobble(false)
    let start = pos
    let d = hypot(target.x - start.x, target.y - start.y)
    if d < 1 { place(); wobble(true); return }
    // quadratic bezier: control point pushed perpendicular to the path so the flight arcs
    let mid = CGPoint(x: (start.x + target.x) / 2, y: (start.y + target.y) / 2)
    let nx = -(target.y - start.y) / d, ny = (target.x - start.x) / d
    let bend = min(d * 0.18, 120) * (Bool.random() ? 1 : -1)
    let ctrl = CGPoint(x: mid.x + nx * bend, y: mid.y + ny * bend)
    let frames = max(18, min(70, Int(d / 14)))
    var prev = start
    for i in 1...frames {
        let u = CGFloat(i) / CGFloat(frames)
        let t = u < 0.5 ? 4 * u * u * u : 1 - pow(-2 * u + 2, 3) / 2  // ease in-out cubic
        let a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t
        pos = CGPoint(x: a * start.x + b * ctrl.x + c * target.x, y: a * start.y + b * ctrl.y + c * target.y)
        // lean into the direction of travel, most at mid-flight, settling upright on landing
        let dx = pos.x - prev.x
        let lean = max(-14, min(14, dx * 1.2)) * sin(u * .pi)
        setRotation(-lean)
        place()
        send(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pos, mouseButton: .left))
        prev = pos
        frame(0.016)
    }
    pos = target; setRotation(0); place(); wobble(true)
}

func ripple() {
    let r = CALayer()
    r.frame = CGRect(x: PAD + hotspot[shape]!.x - 10, y: PAD + 24 - hotspot[shape]!.y - 10, width: 20, height: 20)
    r.cornerRadius = 10; r.borderWidth = 2; r.borderColor = NSColor.systemBlue.cgColor
    win.contentView!.layer!.addSublayer(r)
    let grow = CABasicAnimation(keyPath: "transform.scale"); grow.fromValue = 0.4; grow.toValue = 1.8
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.9; fade.toValue = 0
    let g = CAAnimationGroup(); g.animations = [grow, fade]; g.duration = 0.45; g.isRemovedOnCompletion = false; g.fillMode = .forwards
    r.add(g, forKey: "ripple")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { r.removeFromSuperlayer() }
}

func click(count: Int, right: Bool, mouse: Bool = false) {
    wobble(false); setRotation(0, scale: 0.82); frame(0.07)  // press
    let btn: CGMouseButton = right ? .right : .left
    let viaAX = !mouse && !right && count == 1 && axClick(pos)  // mouse=true forces real mouse events
    for i in stride(from: 1, through: count, by: 1) where !viaAX {  // count 0 = animation only
        let d = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: pos, mouseButton: btn)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); send(d)
        let u = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: pos, mouseButton: btn)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); send(u)
        usleep(60000)
    }
    ripple(); frame(0.05)
    setRotation(0, scale: 1); wobble(true)  // release
}

func drag(to target: CGPoint) {
    setRotation(0, scale: 0.82)
    send(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pos, mouseButton: .left))
    let start = pos, frames = 30
    for i in 1...frames {
        let t = CGFloat(i) / CGFloat(frames)
        pos = CGPoint(x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t)
        place(); send(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: pos, mouseButton: .left))
        usleep(16000)
    }
    send(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pos, mouseButton: .left))
    setRotation(0, scale: 1)
}
// Replace the whole value of the focused text element via Accessibility (form_input).
func axSetValue(_ text: String) -> Bool {
    guard let f = focusedEl() else { return false }
    let role = ax(f, kAXRoleAttribute) as? String ?? ""
    guard ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) else { return false }
    return AXUIElementSetAttributeValue(f, kAXValueAttribute as CFString, text as CFString) == .success
}

func keyCode(_ k: String) -> CGKeyCode? {
    let m: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "f5": 96,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ",": 43, ".": 47, "/": 44, ";": 41,
        "[": 33, "]": 30, "'": 39, "`": 50, "\\": 42, "forwarddelete": 117, "capslock": 57,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
    return m[k.lowercased()]
}

// ---- Accessibility tree as text: `Role name = value @cx,cy`, visible elements only ----
func ax(_ e: AXUIElement, _ attr: String) -> Any? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success ? v : nil
}
func frame(_ e: AXUIElement) -> CGRect {
    var pt = CGPoint.zero, sz = CGSize.zero
    if let p = ax(e, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pt) }
    if let s = ax(e, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
    return CGRect(origin: pt, size: sz)
}
// Containers carry no information of their own; their children are still walked.
let skipRoles: Set<String> = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXToolbar", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXImage", "AXSplitter", "AXWindow", "AXList", "AXOutline", "AXTable", "AXColumn", "AXCell", "AXScrollBar", "AXWebArea", "AXMenuBar", "AXSheet", "AXDrawer", "AXGrowArea"]
// Roles the agent can act on come first in the dump, so the model sees them before plain text.
let interactive: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXTabGroup", "AXRow", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXMenuItem", "AXRadioGroup", "AXColorWell", "AXSegmentedControl"]
var visible = CGRect.zero
var rowsInList = 0
var actEls: [AXUIElement] = [], textEls: [AXUIElement] = []
var seen = Set<String>()
var enabledAX = Set<pid_t>()  // pids we already asked to publish their accessibility tree
var lastEls: [AXUIElement] = []  // elements of the last tree() dump, in the order the lines were emitted (= ref order)
func label(_ e: AXUIElement, _ role: String) -> (String, String) {
    var name = (ax(e, kAXTitleAttribute) as? String) ?? ""
    if name.isEmpty, role != "AXRow", let d = ax(e, kAXDescriptionAttribute) as? String { name = d }  // rows describe "press to open", not content
    if name.isEmpty, let ph = ax(e, kAXPlaceholderValueAttribute) as? String { name = ph }
    var value = ""
    if let v = ax(e, kAXValueAttribute) {
        if let b = v as? Bool { value = b ? "on" : "off" }
        else if let n = v as? NSNumber { value = n.stringValue }
        else if let s = v as? String { value = s }
    }
    value = value.replacingOccurrences(of: "\n", with: " ⏎ ")
    if value.count > 120 { value = String(value.prefix(120)) + "…" }
    if role == "AXRow" || role == "AXCell", name.isEmpty {  // list rows: name from their first text descendant
        var q = (ax(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []; var hops = 0
        while !q.isEmpty && hops < 12 && name.isEmpty {
            let k = q.removeFirst(); hops += 1
            if let t = ax(k, kAXValueAttribute) as? String ?? ax(k, kAXTitleAttribute) as? String, !t.isEmpty { name = t }
            else { q += (ax(k, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
        }
    }
    return (name, value)
}
func walk(_ e: AXUIElement, _ depth: Int, _ inRow: Bool, _ act: inout [String], _ text: inout [String]) {
    if depth > 30 || act.count + text.count > 600 { return }
    let role = ax(e, kAXRoleAttribute) as? String ?? ""
    let f = frame(e)
    // Off-screen / scrolled-out elements are invisible to the user, so they are invisible to the agent too.
    if f.width > 0 && f.height > 0 && !visible.intersects(f) && role != "AXMenuItem" { return }
    if role == "AXList" || role == "AXOutline" || role == "AXTable" { rowsInList = 0 }
    if role == "AXRow" { rowsInList += 1; if rowsInList > 30 { return } }
    var emit = !skipRoles.contains(role) && f.width > 0 && f.height > 0
    // Inside a list row only real controls are worth listing; the row itself carries the text and is the click target.
    if inRow && !["AXButton", "AXCheckBox", "AXPopUpButton", "AXLink", "AXDisclosureTriangle"].contains(role) { emit = false }
    if emit {
        let (name, value) = label(e, role)
        let meaningful = (name + value).unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
        if (!name.isEmpty || !value.isEmpty) && (meaningful || interactive.contains(role)) {  // " • " and friends are noise
            let sub = ax(e, kAXSubroleAttribute) as? String ?? ""
            var r = role.replacingOccurrences(of: "AX", with: "")
            if sub == "AXCloseButton" || sub == "AXSecureTextField" { r = sub.replacingOccurrences(of: "AX", with: "") }
            var line = r
            if !name.isEmpty { line += " \"\(name)\"" }
            if !value.isEmpty && value != name { line += " = \"\(value)\"" }
            if role == "AXStaticText" && name.isEmpty { line = "Text \"\(value)\"" }
            if let en = ax(e, kAXEnabledAttribute) as? Bool, !en { line += " (disabled)" }
            if let sel = ax(e, kAXSelectedAttribute) as? Bool, sel { line += " (selected)" }
            if let fo = ax(e, kAXFocusedAttribute) as? Bool, fo { line += " (focused)" }
            line += " @\(Int(f.midX)),\(Int(f.midY))"
            if seen.contains(line) { return }  // web apps often publish the same control twice
            seen.insert(line)
            if interactive.contains(role) { act.append(line); actEls.append(e) } else { text.append(line); textEls.append(e) }
        }
    }
    for c in (ax(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(c, depth + 1, inRow || role == "AXRow", &act, &text) }
}
func tree() -> String {
    let p = pid()
    guard p != 0, let app = NSRunningApplication(processIdentifier: p) else { return "no target app: call open_app(name) first (list_running_apps shows what is running)" }
    let ae = AXUIElementCreateApplication(p)
    var out = ["app: \(app.localizedName ?? "?")"]
    var w: AXUIElement? = nil
    if let f = ax(ae, kAXFocusedWindowAttribute) { w = (f as! AXUIElement) }
    else if let m = ax(ae, kAXMainWindowAttribute) { w = (m as! AXUIElement) }
    else { w = (ax(ae, kAXWindowsAttribute) as? [AXUIElement])?.first }
    guard let win = w else { return out.joined(separator: "\n") + "\n(no window found — is the app open? Accessibility permission granted?)" }
    // Chromium/Electron apps (Spotify, Discord, Slack, VS Code, Chrome...) expose no accessibility tree until a
    // client asks for it. Setting these attributes switches it on; the tree appears a moment later.
    if !enabledAX.contains(p) {
        enabledAX.insert(p)
        AXUIElementSetAttributeValue(ae, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(ae, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        frame(0.6)
    }
    out.append("window: \(ax(win, kAXTitleAttribute) as? String ?? "")")
    let screen = CGRect(x: 0, y: 0, width: NSScreen.screens[0].frame.width, height: screenH())
    visible = frame(win).intersection(screen)
    var act: [String] = [], text: [String] = []
    actEls = []; textEls = []; lastEls = []; seen = []
    // A sheet/dialog in front of the window is what the user sees; report it first.
    if let sheets = ax(win, "AXSheets") as? [AXUIElement], let s = sheets.first {
        out.append("DIALOG in front of the window:"); walk(s, 0, false, &act, &text)
        out += act; out += text; lastEls += actEls + textEls; act = []; text = []; actEls = []; textEls = []
        out.append("-- window behind the dialog --")
    }
    walk(win, 0, false, &act, &text)
    lastEls += actEls + textEls
    if let fe = focusedEl() {
        let (n, v) = label(fe, ax(fe, kAXRoleAttribute) as? String ?? "")
        out.append("focused: \((ax(fe, kAXRoleAttribute) as? String ?? "").replacingOccurrences(of: "AX", with: "")) \"\(n)\"" + (v.isEmpty ? "" : " = \"\(v)\""))
    }
    out.append("-- interactive (\(act.count)) --"); out += act
    out.append("-- text (\(text.count)) --"); out += text
    return out.joined(separator: "\n")
}
// Press the exact element a ref points at (1-based, in dump order). SwiftUI apps hit-test to a hosting
// container, so pressing by coordinate misses; pressing the element itself works while in the background.
func pressRef(_ i: Int) -> String {
    guard i >= 1 && i <= lastEls.count else { return "stale ref" }
    let e = lastEls[i - 1]
    let role = ax(e, kAXRoleAttribute) as? String ?? ""
    if ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) {
        return AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success ? "ok" : "focus failed"
    }
    var acts: CFArray?; AXUIElementCopyActionNames(e, &acts)
    let names = acts as? [String] ?? []
    for a in ["AXPress", "AXPick", "AXConfirm", "AXOpen"] where names.contains(a) {
        if AXUIElementPerformAction(e, a as CFString) == .success { return "ok" }
    }
    if role == "AXRow" || role == "AXCell" {  // select the row
        if AXUIElementSetAttributeValue(e, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { return "ok" }
    }
    return "no press action"
}

// ---- Menu bar: list and press items without the app being frontmost ----
func menuTitle(_ e: AXUIElement) -> String { ax(e, kAXTitleAttribute) as? String ?? "" }
func menuKids(_ e: AXUIElement) -> [AXUIElement] {
    // AXMenuBarItem/AXMenuItem -> AXMenu -> items
    var kids = (ax(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    if kids.count == 1, ax(kids[0], kAXRoleAttribute) as? String == "AXMenu" { kids = (ax(kids[0], kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
    return kids
}
func menus() -> String {
    if pid() == 0 { return "no target app: call open_app first" }
    guard let bar = ax(appEl(), kAXMenuBarAttribute) else { return "no menu bar (Accessibility permission?)" }
    var out: [String] = []
    for m in (ax(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        let t = menuTitle(m); if t.isEmpty || t == "Apple" { continue }
        var items: [String] = []
        for i in menuKids(m) {
            let it = menuTitle(i); if it.isEmpty { continue }
            let sub = !menuKids(i).isEmpty
            let en = (ax(i, kAXEnabledAttribute) as? Bool) ?? true
            items.append(it + (sub ? " ▸" : "") + (en ? "" : " (disabled)"))
        }
        out.append("\(t): " + items.joined(separator: " | "))
    }
    return out.joined(separator: "\n")
}
func pressMenu(_ path: [String]) -> String {
    if pid() == 0 { return "no target app: call open_app first" }
    guard let bar = ax(appEl(), kAXMenuBarAttribute) else { return "no menu bar" }
    var cur = bar as! AXUIElement
    var kids = (ax(cur, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    for (n, want) in path.enumerated() {
        let w = want.lowercased().trimmingCharacters(in: .whitespaces)
        guard let hit = kids.first(where: { menuTitle($0).lowercased() == w }) ?? kids.first(where: { menuTitle($0).lowercased().hasPrefix(w) }) else {
            return "no menu item \"\(want)\"; available: " + kids.map { menuTitle($0) }.filter { !$0.isEmpty }.joined(separator: " | ")
        }
        cur = hit
        if n == path.count - 1 { break }
        kids = menuKids(cur)
    }
    if let en = ax(cur, kAXEnabledAttribute) as? Bool, !en { return "menu item is disabled" }
    return AXUIElementPerformAction(cur, kAXPressAction as CFString) == .success ? "ok" : "press failed"
}

func handle(_ c: [String: Any]) -> String {
    switch c["op"] as? String {
    case "target":
        targetPid = pidFor(c["app"] as? String ?? "")
        return targetPid == 0 ? "not running" : "pid \(targetPid)"
    case "apps":
        return runningApps()
    case "apps_detail":
        return appsDetail()
    case "move":
        fly(to: CGPoint(x: c["x"] as? Double ?? pos.x, y: c["y"] as? Double ?? pos.y))
    case "click":
        click(count: c["count"] as? Int ?? 1, right: c["button"] as? String == "right", mouse: c["mouse"] as? Bool ?? false)
    case "press":
        return pressRef(c["index"] as? Int ?? 0)
    case "axinfo":  // debug: actions and attributes of the element under a point
        var el: AXUIElement?
        let p = CGPoint(x: c["x"] as? Double ?? pos.x, y: c["y"] as? Double ?? pos.y)
        guard AXUIElementCopyElementAtPosition(appEl(), Float(p.x), Float(p.y), &el) == .success, let e = el else { return "no element" }
        var acts: CFArray?; AXUIElementCopyActionNames(e, &acts)
        var attrs: CFArray?; AXUIElementCopyAttributeNames(e, &attrs)
        var out = "actions: \((acts as? [String] ?? []).joined(separator: ","))\nattrs: \((attrs as? [String] ?? []).joined(separator: ","))"
        for k in ["AXRole", "AXSubrole", "AXTitle", "AXValue", "AXSelected", "AXEnabled"] { if let v = ax(e, k) { out += "\n\(k)=\(v)" } }
        let kids = (ax(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        out += "\nchildren: \(kids.count) " + kids.prefix(6).map { (ax($0, kAXRoleAttribute) as? String ?? "?") + ":" + (ax($0, kAXTitleAttribute) as? String ?? "") }.joined(separator: ", ")
        if let par = ax(e, kAXParentAttribute) { let pe = par as! AXUIElement; out += "\nparent: \(ax(pe, kAXRoleAttribute) ?? "")/\(ax(pe, kAXSubroleAttribute) ?? "") value=\(ax(pe, kAXValueAttribute) ?? "")" }
        return out.replacingOccurrences(of: "\n", with: "\u{1}")
    case "wins":  // debug: on-screen windows under a point, front to back
        let p = CGPoint(x: c["x"] as? Double ?? pos.x, y: c["y"] as? Double ?? pos.y)
        var out: [String] = []
        for w in (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? [] {
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
            let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if r.contains(p) { out.append("pid=\(w[kCGWindowOwnerPID as String] ?? 0) \(w[kCGWindowOwnerName as String] ?? "?") layer=\(w[kCGWindowLayer as String] ?? 0) alpha=\(w[kCGWindowAlpha as String] ?? 1) \(Int(r.width))x\(Int(r.height))") }
        }
        return out.joined(separator: "\u{1}")
    case "state":
        return "pos=\(Int(pos.x)),\(Int(pos.y)) showing=\(showing) overTarget=\(overTarget()) alpha=\(win.alphaValue)"
    case "activate":  // last resort for apps that ignore background input: bring the target to front
        NSRunningApplication(processIdentifier: pid())?.activate(options: [.activateIgnoringOtherApps])
        usleep(400000)
    case "drag":
        drag(to: CGPoint(x: c["x"] as? Double ?? pos.x, y: c["y"] as? Double ?? pos.y))
    case "setvalue":
        return axSetValue(c["value"] as? String ?? "") ? "ok" : "unsupported"
    case "scroll":
        let dy = Int32(c["dy"] as? Int ?? -5)
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)
        e?.location = pos; send(e)
    case "type":
        let text = c["text"] as? String ?? ""
        let f = focusedEl()
        let before = f.flatMap { ax($0, kAXValueAttribute) as? String }
        if !axInsert(text) {
            for ch in text.utf16 {
                var u = ch
                for down in [true, false] {
                    let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                    e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u); send(e)
                }
                usleep(8000)
            }
        }
        // Chromium apps accept neither route while in the background but do honor AXValue: append it there.
        if let f = f, let old = before, (ax(f, kAXValueAttribute) as? String) == old {
            usleep(150000)
            if (ax(f, kAXValueAttribute) as? String) == old {
                return AXUIElementSetAttributeValue(f, kAXValueAttribute as CFString, (old + text) as CFString) == .success ? "ok" : "typing had no effect"
            }
        }
    case "key":
        let name = (c["key"] as? String ?? "").lowercased()
        if mediaKey(name) { return "ok" }
        guard let code = keyCode(name) else { return "unknown key" }
        var flags: CGEventFlags = []
        for m in c["mods"] as? [String] ?? [] {
            switch m { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift)
                       case "alt", "option": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: break }
        }
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); e?.flags = flags; send(e)
        }
    case "shape":
        shape = c["shape"] as? String == "hand" ? "hand" : "arrow"
        cursorLayer.contents = shape == "hand" ? hand : arrow; place()
    case "tree":
        return tree().replacingOccurrences(of: "\n", with: "\u{1}")
    case "menus":
        return menus().replacingOccurrences(of: "\n", with: "\u{1}")
    case "menu":
        return pressMenu(c["path"] as? [String] ?? [])
    case "hide": showing = false; wobble(false); win.orderOut(nil)
    case "show": showing = true; place(); win.orderFrontRegardless(); wobble(true)
    default: return "unknown op"
    }
    return "ok"
}

// Window stacking changes while the cursor sits still (the user raises another app): keep visibility current.
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in if showing { win.alphaValue = overTarget() ? 1 : 0 } }

DispatchQueue.global().async {
    while let line = readLine() {
        guard let d = line.data(using: .utf8), let c = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
        var r = ""
        DispatchQueue.main.sync { r = handle(c) }
        print(r); fflush(stdout)
    }
    exit(0)
}
app.run()
