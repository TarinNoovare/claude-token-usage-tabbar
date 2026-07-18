// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ClaudeTokens",
    platforms: [.macOS(.v13)], // SMAppService (login item) needs macOS 13+
    targets: [
        .executableTarget(
            name: "ClaudeTokens",
            path: "Sources/ClaudeTokens"
        )
    ]
)
