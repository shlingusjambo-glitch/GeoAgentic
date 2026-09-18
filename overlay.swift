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
func place() {
    let hs = hotspot[shape]!
    // tip of the cursor image sits exactly on `pos`
    win.setFrameOrigin(NSPoint(x: pos.x - PAD - hs.x, y: screenH() - pos.y - PAD - 24 + hs.y))
}
func setRotation(_ deg: CGFloat, scale: CGFloat = 1) {
    CATransaction.begin(); CATransaction.setDisableActions(true)
    cursorLayer.setAffineTransform(CGAffineTransform(rotationAngle: deg * .pi / 180).scaledBy(x: scale, y: scale))
    CATransaction.commit()
}

func pidFor(_ name: String) -> pid_t {
    let n = name.lowercased()
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
        if (a.localizedName ?? "").lowercased() == n || (a.bundleURL?.lastPathComponent.lowercased() ?? "") == n + ".app" { return a.processIdentifier }
    }
    return 0
}
func pid() -> pid_t {
    if targetPid != 0, NSRunningApplication(processIdentifier: targetPid) != nil { return targetPid }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}
func send(_ e: CGEvent?) { e?.postToPid(pid()) }
func appEl() -> AXUIElement { AXUIElementCreateApplication(pid()) }
func focusedEl() -> AXUIElement? {
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
    win.orderFrontRegardless()
    let start = pos
    let d = hypot(target.x - start.x, target.y - start.y)
    if d < 1 { return }
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
        usleep(16000)
    }
    pos = target; setRotation(0); place()
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

func click(count: Int, right: Bool) {
    setRotation(0, scale: 0.82); usleep(70000)  // press
    let btn: CGMouseButton = right ? .right : .left
    let viaAX = !right && count == 1 && axClick(pos)
    for i in 1...count where !viaAX {
        let d = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: pos, mouseButton: btn)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); send(d)
        let u = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: pos, mouseButton: btn)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); send(u)
        usleep(60000)
    }
    ripple()
    setRotation(0, scale: 1)  // release
}

func keyCode(_ k: String) -> CGKeyCode? {
    let m: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "f5": 96,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ",": 43, ".": 47, "/": 44, ";": 41]
    return m[k.lowercased()]
}

// ---- Accessibility tree as text: Role | name | value | @cx,cy ----
func ax(_ e: AXUIElement, _ attr: String) -> Any? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success ? v : nil
}
let skipRoles: Set<String> = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXToolbar", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXImage", "AXSplitter", "AXWindow", "AXList", "AXOutline", "AXTable", "AXColumn", "AXCell", "AXScrollBar", "AXWebArea", "AXMenuBar"]
func walk(_ e: AXUIElement, _ depth: Int, _ out: inout [String]) {
    if depth > 25 || out.count > 400 { return }
    let role = ax(e, kAXRoleAttribute) as? String ?? ""
    if !skipRoles.contains(role) {
        var name = (ax(e, kAXTitleAttribute) as? String) ?? (ax(e, kAXDescriptionAttribute) as? String) ?? ""
        if name.isEmpty, let ph = ax(e, kAXPlaceholderValueAttribute) as? String { name = ph }
        var value = ""
        if let v = ax(e, kAXValueAttribute) { value = String(describing: v).replacingOccurrences(of: "\n", with: " ") }
        if value.count > 80 { value = String(value.prefix(80)) }
        if role == "AXRow", name.isEmpty, let kids = ax(e, kAXChildrenAttribute) as? [AXUIElement] {  // sidebar rows: name from first text child
            for k in kids { if let t = ax(k, kAXValueAttribute) as? String ?? ax(k, kAXTitleAttribute) as? String, !t.isEmpty { name = t; break } }
        }
        if !name.isEmpty || !value.isEmpty {
            var pt = CGPoint.zero, sz = CGSize.zero
            if let p = ax(e, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pt) }
            if let s = ax(e, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
            if sz.width > 0 && sz.height > 0 {
                out.append("\(role.replacingOccurrences(of: "AX", with: "")) | \(name) | \(value) | @\(Int(pt.x + sz.width / 2)),\(Int(pt.y + sz.height / 2))")
            }
        }
    }
    for c in (ax(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(c, depth + 1, &out) }
}
func tree() -> String {
    let p = pid()
    guard let app = NSRunningApplication(processIdentifier: p) else { return "no target app" }
    let ae = AXUIElementCreateApplication(p)
    var out = ["app: \(app.localizedName ?? "?")"]
    var w: AXUIElement? = nil
    if let f = ax(ae, kAXFocusedWindowAttribute) { w = (f as! AXUIElement) }
    else if let m = ax(ae, kAXMainWindowAttribute) { w = (m as! AXUIElement) }
    else { w = (ax(ae, kAXWindowsAttribute) as? [AXUIElement])?.first }
    if let w = w {
        out.append("window: \(ax(w, kAXTitleAttribute) as? String ?? "")")
        walk(w, 0, &out)
    } else { out.append("(no window found — is the app open? Accessibility permission granted?)") }
    return out.joined(separator: "\n")
}

func handle(_ c: [String: Any]) -> String {
    switch c["op"] as? String {
    case "target":
        targetPid = pidFor(c["app"] as? String ?? "")
        return targetPid == 0 ? "not running" : "pid \(targetPid)"
    case "move":
        fly(to: CGPoint(x: c["x"] as? Double ?? pos.x, y: c["y"] as? Double ?? pos.y))
    case "click":
        click(count: c["count"] as? Int ?? 1, right: c["button"] as? String == "right")
    case "scroll":
        let dy = Int32(c["dy"] as? Int ?? -5)
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)
        e?.location = pos; send(e)
    case "type":
        let text = c["text"] as? String ?? ""
        if axInsert(text) { return "ok" }
        for ch in text.utf16 {
            var u = ch
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u); send(e)
            }
            usleep(8000)
        }
    case "key":
        guard let code = keyCode(c["key"] as? String ?? "") else { return "unknown key" }
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
    case "hide": win.orderOut(nil)
    case "show": place(); win.orderFrontRegardless()
    default: return "unknown op"
    }
    return "ok"
}

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
