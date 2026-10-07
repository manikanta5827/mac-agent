import Foundation

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

struct Box: Codable {
    let label: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}
