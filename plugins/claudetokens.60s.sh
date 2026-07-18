#!/bin/bash
#
# SwiftBar metadata: hide the default footer items so the dropdown stays clean
# (just our usage bars). These are read by SwiftBar from this plugin file.
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Resolve through symlinks (this file is symlinked into SwiftBar's plugin folder;
# BSD readlink has no -f, so use node to get the real path reliably).
REAL_PATH="$(node -e "console.log(require('fs').realpathSync(process.argv[1]))" "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$REAL_PATH")/.."
exec node "$SCRIPT_DIR/lib/bar.js"
