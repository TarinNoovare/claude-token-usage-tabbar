# claude-token-usage-tabbar

macOS menu bar indicator for your **real** Claude subscription usage — the same
numbers `/usage` shows: 5-hour limit % used, weekly % used, and reset times.

Menu bar shows e.g. `⛁ 15% · 4h28m` (5-hour usage · time until it resets).

## How it gets real numbers

It calls the same endpoint Claude Code's `/usage` uses:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <your Claude OAuth token>
anthropic-beta: oauth-2025-04-20
```

The token is read at runtime from the macOS keychain item `Claude Code-credentials`
(the one the Claude app already created). The response gives `utilization` (0–100)
and `resets_at` per window.

**Why not the local logs (v1)?** The old version parsed `~/.claude/projects/*.jsonl`
and guessed the quota ceiling. It was wrong on both axes — it reported "62% left,
resets in 29 min" when the truth was "15% used, resets in 4h 28min" — because the
server's quota ceiling and reset windows aren't derivable from local token counts.
That approach is gone.

**Why not the statusline hook?** Claude Code's statusline *does* carry real
`rate_limits` data, but it only fires from the terminal TUI. The desktop app runs
the CLI headless (stream-json), so statusline never executes there. Verified against
the app binary: the only caller is the terminal render path. Dead end for desktop
users.

## Security

- The OAuth token is held only in memory and sent **only** to `api.anthropic.com`
  as a Bearer header. It is **never** written to disk, logged, or sent anywhere else.
  See the SECURITY CONTRACT comment in [lib/usage-core.js](lib/usage-core.js).
- The on-disk cache (`~/.cache/claude-tokens/usage-<account>.json`) holds only
  percentages, reset timestamps, and your account email — never the token.
- First run triggers a macOS keychain prompt naming whichever front-end reads the
  token — *"ClaudeTokens wants to use the Claude Code-credentials keychain item"*
  (native app) or *"SwiftBar…"* (legacy plugin). Click **Always Allow** so it can
  read the token unattended. The read is done by Apple's `security` tool in the
  Node child process either way, so the app itself needs no keychain entitlement.

## Caveats

- **Unofficial endpoint.** `/api/oauth/usage` is not a documented/stable API. It may
  change or break without notice. If numbers stop appearing, that's the likely cause.
- **Token refresh.** This tool does not refresh expired tokens itself. The Claude app
  refreshes them in the keychain while it runs; the tool re-reads the keychain each
  fetch, so it picks up fresh tokens automatically. If the app hasn't run for a long
  time and the token is expired, the bar shows an `auth_expired` note — open Claude to
  refresh.
- **Account switching** is handled: usage is cached per account UUID (read from
  `~/.claude.json`), and the endpoint returns data for whichever account the current
  token belongs to. After a switch the bar shows `⛁ …` until the new account's data
  is fetched — it never shows the previous account's numbers. The dropdown always
  names the account the numbers belong to.

## Architecture

Two front-ends share one data core. The **native app** is the recommended way to
run it; the **SwiftBar plugin** is kept for backward compatibility.

Native app (recommended):

```
ClaudeTokens.app (Swift, menu-bar accessory app — no Dock icon)
   └─ re-renders every 60s · on menu open · "Refresh now"
        └─ node lib/status.js        # emits ONE JSON blob: title, rows, ring, level, notify
             ├─ lib/render-model.js    # shared view model + throttled refresh + formatting
             ├─ lib/usage-core.js      # keychain read, API call, per-account cache
             └─ lib/refresh.js         # fetch /api/oauth/usage, write cache
   └─ renders NSStatusItem + NSMenu, notifies via UNUserNotificationCenter
```

SwiftBar plugin (legacy):

```
SwiftBar (every 60s)
   └─ plugins/claudetokens.60s.sh
        └─ lib/bar.js                 # serializes the SAME model to SwiftBar's line DSL
```

- **lib/render-model.js** — builds the neutral view model from the cache and owns
  the throttled refresh. **Render and fetch are decoupled**: the front-ends
  re-render every 60s (cache-only — this keeps the "resets in …" countdown ticking
  every minute), but this only spawns a real API refetch when the cache is older
  than **55s**, so `/api/oauth/usage` is hit ~once/min. Rather than guessing a
  "safe" rate, it **backs off on demand**: a 429 records the server's `Retry-After`
  into `cache.rate_limited_until`, and `maybeRefresh` skips fetching until that
  passes (falling back to 5 min if no header). Shared by both front-ends.
- **lib/status.js** — native-app entry. Emits the model as JSON; always prints
  valid JSON, even on internal error (`state:"error"`).
- **lib/bar.js** — SwiftBar entry. Serializes the model to SwiftBar's DSL and keeps
  the legacy `osascript` notification.
- **lib/refresh.js** — the actual token read + API call + cache write. Run it
  standalone to force a refresh.
- **lib/usage-core.js** — shared data logic and the security contract.

Zero dependencies on both sides — pure Node standard library, and no third-party
Swift packages.

### The Swift ↔ Node seam

The Swift app is a thin UI shell: it execs `node lib/status.js`, decodes the JSON,
and drives the menu bar. All data + formatting (keychain, API, cache, colors,
thresholds, the ring PNG) stay in Node. Locating `node` from a GUI app (which
doesn't inherit your shell `PATH`) is handled by a login-shell probe plus a scan
of the usual Homebrew/nvm/asdf/volta locations; override with `nodePath` (see
Configuration) if needed.

## Setup

### Native app (recommended)

Requires **Node 18+** and the **Swift toolchain** (Command Line Tools is enough —
`xcode-select --install`; full Xcode not needed).

1. **Verify the data path** (this reads your token — run it yourself):
   ```bash
   node lib/status.js | node -e 'const p=JSON.parse(require("fs").readFileSync(0));console.log(p.state, p.title)'
   ```
   First run pops the keychain prompt → **Always Allow**. `state` should be `ok`
   and `title` should match `/usage` in Claude Code.
2. **Build, sign, and install** the menu-bar app:
   ```bash
   make install          # → /Applications/ClaudeTokens.app (ad-hoc signed, free)
   open -a ClaudeTokens
   ```
   `make run` builds and launches without installing; `make selftest` runs a
   headless pipeline check. To share it, publish a Homebrew tap — see
   [packaging/homebrew/README.md](packaging/homebrew/README.md).
3. Optional: toggle **Open at Login** from the app's dropdown.

### SwiftBar plugin (legacy / alternative)

1. `node lib/refresh.js && cat ~/.cache/claude-tokens/usage-*.json` — Always Allow.
2. `brew install --cask swiftbar`
3. Point SwiftBar at this repo's `plugins/` folder, or symlink the plugin in.

### Migrating from SwiftBar to the app

They read the same cache, so you can run both while you try the app. When you're
happy, disable the plugin — remove the `plugins/claudetokens.60s.sh` symlink from
SwiftBar's plugin folder (or toggle it off in SwiftBar). The only overlap if both
run is a possible duplicate threshold notification.

## Configuration

`config.json`:
```json
{ "warnPercent": 80, "criticalPercent": 95 }
```
The ring/menu bar turns orange at ≥80% used and red at ≥95% used, and fires a single
notification the first time 5-hour usage crosses each threshold (re-armed when the
window resets). The native app delivers it via `UNUserNotificationCenter` (attributed
to ClaudeTokens); the legacy plugin uses `osascript`. These are **% used** (higher =
closer to the limit), the opposite of v1's "% left".

**Optional `nodePath`.** If the app can't find your `node` binary, set an absolute
path:
```json
{ "warnPercent": 80, "criticalPercent": 95, "nodePath": "/opt/homebrew/bin/node" }
```
The app reads `config.json` from `~/Library/Application Support/ClaudeTokens/` first,
then the copy bundled inside the `.app`. (Thresholds are read by the Node layer from
the bundled copy.)
