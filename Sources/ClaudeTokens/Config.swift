import Foundation

// Reads the optional `nodePath` override from config.json. Checked in order:
//   1. ~/Library/Application Support/ClaudeTokens/config.json  (user override)
//   2. <app bundle>/Contents/Resources/config.json            (shipped default)
//   3. $CLAUDE_TOKENS_LIB/../config.json                       (dev, repo root)
// Thresholds (warnPercent/criticalPercent) are consumed by the Node layer from
// the same config.json it sees (bundle Resources), so they're not read here.
enum Config {
    static func nodePathOverride() -> String? {
        for url in candidateURLs() {
            guard
                let data = try? Data(contentsOf: url),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let np = obj["nodePath"] as? String,
                !np.isEmpty
            else { continue }
            return (np as NSString).expandingTildeInPath
        }
        return nil
    }

    private static func candidateURLs() -> [URL] {
        var urls: [URL] = []
        if let appSup = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            urls.append(appSup.appendingPathComponent("ClaudeTokens/config.json"))
        }
        if let res = Bundle.main.resourceURL {
            urls.append(res.appendingPathComponent("config.json"))
        }
        if let lib = ProcessInfo.processInfo.environment["CLAUDE_TOKENS_LIB"] {
            urls.append(URL(fileURLWithPath: lib).deletingLastPathComponent().appendingPathComponent("config.json"))
        }
        return urls
    }
}
