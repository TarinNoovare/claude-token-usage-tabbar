import AppKit

// Menu-bar-only accessory app: no Dock icon, no app menu. The status item and
// all rendering live in AppDelegate. Pairs with LSUIElement=true in Info.plist.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
