#!/usr/bin/env bash
set -euo pipefail

# Assemble ClaudeTokens.app from the SwiftPM build product plus the Node lib.
# Ad-hoc signed (free) — for build-from-source installs the binary is compiled
# locally, so it isn't quarantined and needs no Developer ID / notarization.
#
# Env overrides: CONFIG (debug|release, default release), DEST (output dir).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="ClaudeTokens"
BUNDLE_ID="com.claudetokens.app"
CONFIG="${CONFIG:-release}"
DEST="${DEST:-$ROOT/build}"
APP="$DEST/$APP_NAME.app"

VERSION="$(node -e "process.stdout.write(require('./package.json').version||'0.0.0')" 2>/dev/null || echo 0.0.0)"

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG" --disable-sandbox
BIN="$(swift build -c "$CONFIG" --show-bin-path)/$APP_NAME"

echo "==> assembling $APP (v$VERSION)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/lib"
cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"
cp lib/*.js "$APP/Contents/Resources/lib/"
cp config.json "$APP/Contents/Resources/config.json"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>Claude Tokens</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Unofficial. Reads the Claude OAuth usage endpoint.</string>
</dict>
</plist>
PLIST

echo "==> ad-hoc codesign"
codesign --force --sign - "$APP"

echo "==> done: $APP"
