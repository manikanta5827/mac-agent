import AppKit
import ApplicationServices

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

func name(_ element: AXUIElement) -> String? {
    text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute)
        ?? text(element, kAXPlaceholderValueAttribute) ?? text(element, kAXHelpAttribute)
}

func runningApp(named appName: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first {
        $0.localizedName?.caseInsensitiveCompare(appName) == .orderedSame
    }
}

func appElement(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 2.0)
    return element
}

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
