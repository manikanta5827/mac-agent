// ax-helper: reads and operates native Mac app UIs through the macOS Accessibility API.
// It is to Mac apps what agent-browser is to Chrome: a text tree of elements instead of pixels.
//
// Build:   swiftc -O native/ax-helper.swift -o bin/ax-helper
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
import UniformTypeIdentifiers

let maxNodes = 1500
let maxDepth = 40
let maxTextChars = 200

struct Node: Codable {
    let path: String
    let depth: Int
    let role: String
    let subrole: String?
    let name: String?
    let value: String?
    let x: Double?
    let y: Double?
    let w: Double?
    let h: Double?
    let actions: [String]
    let enabled: Bool?
    let focused: Bool?
}

struct Snapshot: Codable {
    let app: String
    let pid: Int32
    let nodes: [Node]
    let truncated: Bool
}

struct Result: Codable {
    let ok: Bool
    let role: String?
    let name: String?
    let error: String?
}

// ---------- small Accessibility helpers ----------

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    var result: String?
    if let string = value as? String { result = string }
    else if let number = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() { result = number.stringValue }
    guard let s = result?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return s.count > maxTextChars ? String(s.prefix(maxTextChars)) + "…" : s
}

func bool(_ element: AXUIElement, _ name: String) -> Bool? {
    attribute(element, name) as? Bool
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func windows(_ app: AXUIElement) -> [AXUIElement] {
    (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

/// Top-level UI of the app: all its children except the menu bar (windows, sheets, panels, dialogs).
/// Some panels (e.g. file pickers) are not in the AXWindows list but are children of the app.
func roots(_ app: AXUIElement) -> [AXUIElement] {
    let tops = children(app).filter { text($0, kAXRoleAttribute) != "AXMenuBar" }
    return tops.isEmpty ? windows(app) : tops
}

func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &s) ? s : nil
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

/// Best human-readable name: title, then description, then placeholder, then help text.
func name(_ element: AXUIElement) -> String? {
    text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute)
        ?? text(element, kAXPlaceholderValueAttribute) ?? text(element, kAXHelpAttribute)
}

// ---------- finding the app and elements ----------

func runningApp(named appName: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first {
        $0.localizedName?.caseInsensitiveCompare(appName) == .orderedSame
    }
}

func appElement(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 2.0) // a hung app must not hang the agent
    return element
}

/// Follows a path like "0.3.2": window 0, then child 3, then child 2.
func element(at path: String, in app: AXUIElement) -> AXUIElement? {
    let steps = path.split(separator: ".").compactMap { Int($0) }
    guard let first = steps.first, steps.count == path.split(separator: ".").count else { return nil }
    let tops = roots(app)
    guard first >= 0, first < tops.count else { return nil }
    var current = tops[first]
    for index in steps.dropFirst() {
        let kids = children(current)
        guard index >= 0, index < kids.count else { return nil }
        current = kids[index]
    }
    return current
}

// ---------- commands ----------

func snapshot(_ app: NSRunningApplication) -> Snapshot {
    let root = appElement(app)
    var nodes: [Node] = []
    var truncated = false

    func visit(_ element: AXUIElement, path: String, depth: Int) {
        if nodes.count >= maxNodes || depth > maxDepth { truncated = true; return }
        let position = point(element, kAXPositionAttribute)
        let dimensions = size(element, kAXSizeAttribute)
        nodes.append(Node(
            path: path,
            depth: depth,
            role: text(element, kAXRoleAttribute) ?? "AXUnknown",
            subrole: text(element, kAXSubroleAttribute),
            name: name(element),
            value: text(element, kAXValueAttribute),
            x: position.map { Double($0.x) }, y: position.map { Double($0.y) },
            w: dimensions.map { Double($0.width) }, h: dimensions.map { Double($0.height) },
            actions: actionNames(element).filter { !$0.hasPrefix("AXScrollTo") && $0 != "AXShowMenu" },
            enabled: bool(element, kAXEnabledAttribute),
            focused: bool(element, kAXFocusedAttribute)
        ))
        for (i, child) in children(element).enumerated() {
            visit(child, path: "\(path).\(i)", depth: depth + 1)
        }
    }

    for (i, top) in roots(root).enumerated() {
        visit(top, path: "\(i)", depth: 0)
    }
    return Snapshot(app: app.localizedName ?? "", pid: app.processIdentifier, nodes: nodes, truncated: truncated)
}

func describe(_ element: AXUIElement, ok: Bool, error: String? = nil) -> Result {
    Result(ok: ok, role: text(element, kAXRoleAttribute), name: name(element), error: error)
}

func output<T: Encodable>(_ value: T) {
    let data = try! JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    output(Result(ok: false, role: nil, name: nil, error: message))
    exit(1)
}

// ---------- drawing numbered boxes on a screenshot ----------

/// One box to draw, in the image's own pixels (top-left origin).
struct Box: Codable {
    let label: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

let boxColors: [NSColor] = [.systemRed, .systemBlue, .systemGreen, .systemOrange, .systemPurple, .systemPink]

/// Reads `input`, draws a thin box and a small number label for every box, writes a JPEG to `outputPath`.
func annotate(input: String, outputPath: String, boxes: [Box]) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Cannot read image \(input)") }
    let width = image.width, height = image.height
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("Cannot create drawing context") }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    // Flip so (0,0) is the top-left corner, like screenshot pixels.
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)

    let font = NSFont.boldSystemFont(ofSize: 11)
    for (i, box) in boxes.enumerated() {
        let color = boxColors[i % boxColors.count]
        let rect = CGRect(x: box.x, y: box.y, width: box.w, height: box.h)
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(2)
        ctx.stroke(rect)

        // Label: white number on a filled tag, just above the box's top-left corner (inside if no room above).
        let text = box.label as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let size = text.size(withAttributes: attributes)
        let tag = CGSize(width: size.width + 4, height: size.height)
        let tagY = box.y - tag.height >= 0 ? box.y - tag.height : box.y
        let tagRect = CGRect(x: box.x, y: tagY, width: tag.width, height: tag.height)
        ctx.setFillColor(color.cgColor)
        ctx.fill(tagRect)
        text.draw(at: CGPoint(x: tagRect.minX + 2, y: tagRect.minY), withAttributes: attributes)
    }
    NSGraphicsContext.current = nil

    guard let result = ctx.makeImage(),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outputPath) as CFURL,
                                                            UTType.jpeg.identifier as CFString, 1, nil) else {
        fail("Cannot write image \(outputPath)")
    }
    CGImageDestinationAddImage(destination, result, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fail("Cannot write image \(outputPath)") }
}

// ---------- main ----------

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: ax-helper check|snapshot|press|focus|set|activate|annotate ...") }

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
