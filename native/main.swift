// ax-helper: reads and operates native Mac app UIs through the macOS Accessibility API.
// It is to Mac apps what agent-browser is to Chrome: a text tree of elements instead of pixels.
//
// Build:   swiftc -O native/*.swift -o bin/ax-helper
// Usage:   ax-helper check                        -> is this process allowed to use Accessibility?
//          ax-helper snapshot <app>               -> JSON list of the app's UI elements
//          ax-helper press <app> <path> <role>        -> press a button / menu item / checkbox
//          ax-helper focus <app> <path> <role>        -> bring the app to front and focus the element (then type with cliclick)
//
// <app> is the app's name, e.g. "TextEdit". <path> is where an element sits in the tree, e.g. "0.3.2"
// = window 0 -> its child 3 -> that element's child 2. Each run is a new process, so elements are found
// again by path. <role> is the role the element had in the snapshot (e.g. AXButton): if the window changed
// and the path now points at something else, the command refuses instead of pressing the wrong thing.
//
// Permission: the app that runs this (your terminal) needs System Settings > Privacy & Security > Accessibility.

import AppKit
import ApplicationServices

func output<T: Encodable>(_ value: T) {
    let data = try! JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    output(Result(ok: false, role: nil, name: nil, error: message))
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: ax-helper check|snapshot|press|focus|activate|annotate ...") }

if command == "check" {
    output(["trusted": AXIsProcessTrusted()])
    exit(0)
}

// frontmost: which app is in front right now, by name and bundle id (needs no Accessibility permission).
if command == "frontmost" {
    let front = NSWorkspace.shared.frontmostApplication
    output(["name": front?.localizedName ?? "", "bundleId": front?.bundleIdentifier ?? ""])
    exit(0)
}

// annotate <input.jpg> <output.jpg>, boxes as JSON on stdin. Pure drawing: needs no Accessibility permission.
if command == "annotate" {
    guard args.count >= 3 else { fail("usage: ax-helper annotate <input.jpg> <output.jpg>  (boxes JSON on stdin)") }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let boxes = try? JSONDecoder().decode([Box].self, from: data) else { fail("Boxes on stdin must be JSON [{label,x,y,w,h}]") }
    annotate(input: args[1], outputPath: args[2], boxes: boxes)
    output(Result(ok: true, role: nil, name: nil, error: nil))
    exit(0)
}

// scroll <dy> [dx]: scrolls at current mouse position. dy > 0 scrolls down, dy < 0 scrolls up.
if command == "scroll" {
    guard args.count >= 2, let dy = Int32(args[1]) else { fail("usage: ax-helper scroll <dy> [dx]") }
    let dx = args.count >= 3 ? (Int32(args[2]) ?? 0) : 0
    // In CGEvent scroll wheel, positive wheel1 scrolls up, negative scrolls down
    if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) {
        event.post(tap: .cghidEventTap)
        output(["ok": true])
        exit(0)
    } else {
        fail("Failed to create scroll event")
    }
}

guard AXIsProcessTrusted() else {
    fail("Accessibility permission missing for the app running this (System Settings > Privacy & Security > Accessibility)")
}
guard args.count >= 2, let app = runningApp(named: args[1]) else {
    fail("App is not running: \(args.count >= 2 ? args[1] : "?"). Open it first (open_app), then take the snapshot.")
}

switch command {
case "snapshot":
    // Electron / Chromium apps (Docker Desktop, Slack, VS Code, ...) only build their accessibility tree
    // when an assistive tool asks for it. Ask; other apps just ignore this attribute.
    let root = appElement(app)
    if AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        Thread.sleep(forTimeInterval: 0.5) // give the app a moment to build the tree the first time
    }
    output(snapshot(app))

case "activate":
    // Bring the app to the front (before a screenshot, so its boxes are not drawn over other windows).
    app.activate()
    output(Result(ok: true, role: nil, name: app.localizedName, error: nil))

case "debug":
    // What does the app expose at the top level? Helps when a snapshot comes back empty.
    let root = appElement(app)
    let describeTop = { (e: AXUIElement) in "\(text(e, kAXRoleAttribute) ?? "?") \"\(name(e) ?? "")\" children=\(children(e).count)" }
    output([
        "app": [app.localizedName ?? "", app.bundleIdentifier ?? ""],
        "appChildren": children(root).map(describeTop),
        "windows": windows(root).map(describeTop),
        "focusedWindow": [(attribute(root, kAXFocusedWindowAttribute)).map { describeTop($0 as! AXUIElement) } ?? "none"],
    ])

case "press", "focus":
    guard args.count >= 4 else { fail("usage: ax-helper \(command) <app> <path> <role>") }
    guard let target = element(at: args[2], in: appElement(app)) else {
        fail("No element at path \(args[2]). The window changed: take a new snapshot.")
    }
    let role = text(target, kAXRoleAttribute) ?? "AXUnknown"
    guard role == args[3] else {
        fail("The element changed (expected \(args[3]), found \(role)). The window changed: take a new snapshot.")
    }
    if command == "press" {
        let status = AXUIElementPerformAction(target, kAXPressAction as CFString)
        output(describe(target, ok: status == .success, error: status == .success ? nil : "press failed (\(status.rawValue))"))
    } else {
        app.activate()
        let status = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        output(describe(target, ok: status == .success, error: status == .success ? nil : "focus failed (\(status.rawValue))"))
    }

default:
    fail("unknown command \(command)")
}
