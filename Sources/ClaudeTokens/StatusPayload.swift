import Foundation

// Mirrors the JSON contract emitted by lib/status.js (schemaVersion 1).
// Everything is optional so a partial or future payload still decodes and the
// UI degrades gracefully instead of throwing.
struct StatusPayload: Decodable {
    let schemaVersion: Int?
    let state: String?            // "ok" | "no_account" | "no_data" | "error"
    let title: String?            // menu-bar text
    let ringPngBase64: String?    // ring icon PNG (color baked in → NOT a template image)
    let level: String?            // "ok" | "warn" | "critical"
    let rows: [Row]?              // dropdown body + footer, in order
    let account: Account?
    let updatedAt: Double?        // epoch seconds
    let lastError: String?
    let lastErrorDetail: String?
    let notify: Notify?

    struct Row: Decodable {
        let text: String?
        let color: String?        // "#rrggbb"
        let mono: Bool?           // Menlo/monospaced row
        let separator: Bool?      // true → menu separator, ignore other fields
    }

    struct Account: Decodable {
        let email: String?
        let uuid: String?
    }

    struct Notify: Decodable {
        let windowKey: String?    // "<uuid>:<five_hour.resets_at>"
        let level: String?        // "ok" | "warn" | "critical"
        let text: String?
    }
}
