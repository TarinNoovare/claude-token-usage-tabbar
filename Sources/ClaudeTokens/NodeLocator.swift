import Foundation

// Finds the `node` binary. GUI apps launched from Finder/Login Items inherit
// only launchd's minimal PATH (no Homebrew, no version managers), so bare
// `node` / `/usr/bin/env node` fail. Resolution order:
//   1. explicit override (config.json "nodePath")
//   2. login-shell probe: `zsh -lc 'command -v node'` — mirrors how the user's
//      Terminal finds node, covering Homebrew, nvm, asdf, volta, fnm
//   3. candidate path scan
enum NodeLocator {
    static func resolve(overridePath: String?) -> String? {
        if let o = overridePath, isExecutable(o) { return o }
        if let p = loginShellNode(), isExecutable(p) { return p }
        for c in candidates() where isExecutable(c) { return c }
        return nil
    }

    private static func isExecutable(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        let fm = FileManager.default
        return fm.fileExists(atPath: path, isDirectory: &isDir)
            && !isDir.boolValue
            && fm.isExecutableFile(atPath: path)
    }

    private static func loginShellNode() -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        // `command -v node` prints a single short path; read-then-wait is safe.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard
            let s = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !s.isEmpty
        else { return nil }
        let first = s.split(separator: "\n").first.map(String.init) ?? s
        return first.hasPrefix("/") ? first : nil // ignore shell functions/aliases
    }

    private static func candidates() -> [String] {
        let home = NSHomeDirectory()
        var list = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.asdf/shims/node",
            "/opt/local/bin/node",
            "/usr/bin/node",
        ]
        // Newest installed nvm node, if any.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted().reversed() {
                list.append("\(nvm)/\(v)/bin/node")
            }
        }
        return list
    }
}
