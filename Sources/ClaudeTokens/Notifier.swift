import Foundation
import UserNotifications

// Native notifications, ported from bar.js maybeNotify(): fire once when the
// 5-hour "used" level crosses a threshold upward; a new reset window or account
// switch (windowKey change) re-arms. State persists in UserDefaults.
//
// Requires a bundle identifier (UNUserNotificationCenter.current() traps without
// one), so it self-disables when run as a bare binary outside an .app bundle.
final class Notifier {
    private let enabled: Bool
    private var authorized = false
    private let rank: [String: Int] = ["ok": 0, "warn": 1, "critical": 2]
    private let defaults = UserDefaults.standard
    private let keyWindow = "notifyWindowKey"
    private let keyLevel = "notifyLastLevel"

    init() {
        enabled = (Bundle.main.bundleIdentifier != nil)
    }

    func requestAuthorization() {
        guard enabled else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            self?.authorized = granted
        }
    }

    func handle(_ notify: StatusPayload.Notify?) {
        guard enabled, let n = notify, let key = n.windowKey, let level = n.level else { return }

        var lastLevel = defaults.string(forKey: keyLevel) ?? "ok"
        if defaults.string(forKey: keyWindow) != key {
            defaults.set(key, forKey: keyWindow)
            defaults.set("ok", forKey: keyLevel)
            lastLevel = "ok"
        }

        let cur = rank[level] ?? 0
        let prev = rank[lastLevel] ?? 0
        if cur > prev {
            fire(n.text ?? "Usage threshold crossed")
            defaults.set(level, forKey: keyLevel)
        } else if cur < prev {
            defaults.set(level, forKey: keyLevel) // dropped (e.g. after reset) → re-arm silently
        }
    }

    private func fire(_ body: String) {
        guard authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = "Claude tokens"
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
