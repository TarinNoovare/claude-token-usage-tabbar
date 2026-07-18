import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var timer: Timer?
    private let runner = NodeRunner()
    private let notifier = Notifier()

    private var nodePath: String?
    private var scriptPath: String = ""
    private var lastGood: StatusPayload?
    private var inFlight = false
    private var pending = false
    private var menuOpen = false

    // MARK: - lifecycle

    func applicationDidFinishLaunching(_ note: Notification) {
        // Headless pipeline check (Swift→Node→decode→ring) for CI/dev, no UI.
        if ProcessInfo.processInfo.environment["CLAUDE_TOKENS_SELFTEST"] != nil {
            runSelfTest()
            return
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.title = "…"

        menu.delegate = self
        menu.autoenablesItems = false // keep colored display rows from graying out
        statusItem.menu = menu

        scriptPath = Self.resolveScriptPath()
        nodePath = NodeLocator.resolve(overridePath: Config.nodePathOverride())
        notifier.requestAuthorization()

        buildMenu(from: nil) // placeholder until first payload
        refresh()

        // 60s render tick in .common mode so it keeps firing while a menu is
        // open. This only RE-RENDERS from cache each minute (cheap, no API) so
        // the "resets in …" countdown stays fresh; the actual network refetch is
        // throttled separately in Node (REFRESH_AFTER_S=55 → ~once/min) and backs
        // off automatically if the endpoint ever returns HTTP 429 (Retry-After).
        let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        t.tolerance = 5
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // MARK: - script/node resolution

    static func resolveScriptPath() -> String {
        // dev override: $CLAUDE_TOKENS_LIB points at the repo's lib/ directory
        if let lib = ProcessInfo.processInfo.environment["CLAUDE_TOKENS_LIB"] {
            return (lib as NSString).appendingPathComponent("status.js")
        }
        // bundled: Contents/Resources/lib/status.js
        if let res = Bundle.main.resourceURL {
            let p = res.appendingPathComponent("lib/status.js").path
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return ""
    }

    // MARK: - refresh cycle

    @objc private func refreshClicked() { refresh() }

    private func refresh() {
        if inFlight { pending = true; return } // coalesce; never stack execs

        if nodePath == nil { nodePath = NodeLocator.resolve(overridePath: Config.nodePathOverride()) }
        guard let node = nodePath else { buildNodeMissingMenu(); return }
        guard !scriptPath.isEmpty else { applyError("status.js not found in app bundle"); return }

        inFlight = true
        runner.run(nodePath: node, script: scriptPath) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.handleResult(result)
                self.inFlight = false
                if self.pending { self.pending = false; self.refresh() }
            }
        }
    }

    private func handleResult(_ result: RunResult) {
        switch result {
        case .launchFailed(let msg):
            nodePath = nil // re-resolve on next tick (node moved / ENOENT)
            applyError("node launch failed: \(msg)")
        case .failure(let msg):
            applyError(msg)
        case .success(let data):
            guard let payload = try? JSONDecoder().decode(StatusPayload.self, from: data) else {
                applyError("bad JSON from status.js")
                return
            }
            lastGood = payload
            apply(payload)
            notifier.handle(payload.notify)
        }
    }

    // MARK: - rendering

    private func apply(_ p: StatusPayload) {
        statusItem.button?.title = p.title ?? "⛁"
        if let b64 = p.ringPngBase64, let img = Self.makeRing(b64) {
            statusItem.button?.image = img
        } else {
            statusItem.button?.image = nil
        }
        if !menuOpen { buildMenu(from: p) } // avoid rebuilding an open menu (flicker)
    }

    private func applyError(_ msg: String) {
        if lastGood == nil {
            statusItem.button?.title = "⛁ —"
            statusItem.button?.image = nil
        }
        if !menuOpen { buildMenu(from: lastGood, errorNote: msg) }
    }

    private func buildMenu(from p: StatusPayload?, errorNote: String? = nil) {
        menu.removeAllItems()

        if let rows = p?.rows, !rows.isEmpty {
            for row in rows {
                if row.separator == true { menu.addItem(.separator()) } else { menu.addItem(displayItem(row)) }
            }
        } else if errorNote == nil {
            menu.addItem(displayRow("Loading…"))
        }

        if let note = errorNote {
            menu.addItem(.separator())
            menu.addItem(displayRow("⚠️ \(note)", color: "#c0392b"))
        }

        menu.addItem(.separator())
        addAction("Refresh now", #selector(refreshClicked), key: "r")
        addLoginToggle()
        menu.addItem(.separator())
        addAction("Quit ClaudeTokens", #selector(quitClicked), key: "q")
    }

    private func buildNodeMissingMenu() {
        statusItem.button?.title = "⛁⚠︎"
        statusItem.button?.image = nil
        menu.removeAllItems()
        menu.addItem(displayRow("Node.js not found", color: "#c0392b"))
        menu.addItem(displayRow("Set \"nodePath\" in config.json"))
        menu.addItem(.separator())
        addAction("Retry", #selector(refreshClicked), key: "r")
        menu.addItem(.separator())
        addAction("Quit ClaudeTokens", #selector(quitClicked), key: "q")
    }

    // MARK: - menu item builders

    private func displayItem(_ row: StatusPayload.Row) -> NSMenuItem {
        let text = row.text ?? ""
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        let size: CGFloat = 13
        let font: NSFont = (row.mono == true)
            ? (NSFont(name: "Menlo", size: size) ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular))
            : NSFont.menuFont(ofSize: 0)
        var attrs: [NSAttributedString.Key: Any] = [.font: font]
        if let hex = row.color, let color = NSColor(hex: hex) { attrs[.foregroundColor] = color }
        item.attributedTitle = NSAttributedString(string: text, attributes: attrs)
        return item
    }

    private func displayRow(_ text: String, color: String? = nil) -> NSMenuItem {
        displayItem(StatusPayload.Row(text: text, color: color, mono: nil, separator: nil))
    }

    @discardableResult
    private func addAction(_ title: String, _ selector: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
        return item
    }

    // MARK: - ring image

    static func makeRing(_ base64: String) -> NSImage? {
        guard let data = Data(base64Encoded: base64), let rep = NSBitmapImageRep(data: data) else { return nil }
        // Treat the PNG as @2x (points = pixels / 2) so it's crisp on Retina.
        let image = NSImage(size: NSSize(width: CGFloat(rep.pixelsWide) / 2.0, height: CGFloat(rep.pixelsHigh) / 2.0))
        image.addRepresentation(rep)
        image.isTemplate = false // ring color encodes warn/critical; do not tint
        return image
    }

    // MARK: - login item (SMAppService, macOS 13+)

    private func addLoginToggle() {
        let item = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        item.target = self
        item.state = loginEnabled ? .on : .off
        menu.addItem(item)
    }

    private var loginEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("ClaudeTokens: login toggle failed: \(error.localizedDescription)")
        }
    }

    @objc private func quitClicked() { NSApp.terminate(nil) }

    // MARK: - self test (headless)

    private func runSelfTest() {
        scriptPath = Self.resolveScriptPath()
        let node = NodeLocator.resolve(overridePath: Config.nodePathOverride())
        print("selftest: node   = \(node ?? "NOT FOUND")")
        print("selftest: script = \(scriptPath.isEmpty ? "NOT FOUND" : scriptPath)")
        guard let node = node, !scriptPath.isEmpty else { exit(2) }
        runner.run(nodePath: node, script: scriptPath) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let data):
                    guard let p = try? JSONDecoder().decode(StatusPayload.self, from: data) else {
                        print("selftest: JSON decode FAILED; raw=\(String(data: data, encoding: .utf8)?.prefix(200) ?? "")")
                        exit(3)
                    }
                    print("selftest: state=\(p.state ?? "?") title=\(p.title ?? "?") level=\(p.level ?? "?") rows=\(p.rows?.count ?? 0)")
                    if let b64 = p.ringPngBase64 {
                        print("selftest: ring = \(Self.makeRing(b64) != nil ? "decoded OK (\(b64.count) b64 chars)" : "DECODE FAILED")")
                    } else {
                        print("selftest: ring = none")
                    }
                    print("selftest: OK")
                    exit(0)
                case .failure(let m): print("selftest: node failure: \(m)"); exit(4)
                case .launchFailed(let m): print("selftest: launch failed: \(m)"); exit(5)
                }
            }
        }
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        refresh() // freshen on open (Node throttles the actual network refetch)
    }

    func menuDidClose(_ menu: NSMenu) {
        menuOpen = false
        // Apply any update that arrived while open, without clobbering the
        // node-missing diagnostic when we've never had good data.
        if let p = lastGood {
            buildMenu(from: p)
        } else if nodePath == nil {
            buildNodeMissingMenu()
        }
    }
}
