# claude-token-usage-tabbar

A macOS **menu bar** indicator for your **real** Claude subscription usage — the
same numbers Claude Code's `/usage` shows: how much of your 5-hour limit and
weekly limits you've used, and when each one resets.

The menu bar shows a small usage ring next to text like `15% · 4h28m`
(5-hour usage · time until it resets). The colour shifts from blue → orange →
red as you approach the limit. Click it for a full breakdown:

```
Your usage limits · Updated 14:32
5-hour limit                        resets in 4h28m
███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   15%
Weekly · all                        resets Wed 09:00
█████████████░░░░░░░░░░░░░░░░░░░░░░░░   36%
Weekly · Opus                       resets Wed 09:00
██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   18%
```

## Why this exists

The numbers are **real** — pulled from the same server-side endpoint Claude Code
uses, not estimated from local logs. It calls:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <your Claude OAuth token>
anthropic-beta: oauth-2025-04-20
```

The response gives a `utilization` percentage (0–100) and a `resets_at`
timestamp per window (5-hour, 7-day all, 7-day Opus, 7-day Sonnet). The OAuth
token is read at runtime from the macOS keychain item `Claude Code-credentials`
that the Claude app / Claude Code CLI already created — this tool never asks you
to log in or paste a token.

> Earlier attempts at parsing `~/.claude/projects/*.jsonl` or the statusline hook
> couldn't produce accurate numbers (the quota ceiling and reset windows aren't
> derivable locally, and the statusline hook never fires under the desktop app).
> The OAuth usage endpoint is the only source that matches `/usage` exactly.

## Requirements

- **macOS 13+** (Ventura or later — the "Open at Login" toggle uses `SMAppService`).
- **Node.js 18+** — all the data logic runs in Node.
- **Swift toolchain** — Command Line Tools is enough (`xcode-select --install`);
  full Xcode is not required. *(Native app only.)*
- The **Claude app or Claude Code CLI** must have signed in at least once, so the
  `Claude Code-credentials` keychain item exists.

## Install

### Native app (recommended)

```bash
# 1. Verify the data path works and pops the keychain prompt → click "Always Allow".
node lib/status.js | node -e 'const p=JSON.parse(require("fs").readFileSync(0));console.log(p.state, p.title)'
#    Expect:  ok  15% · 4h28m   (should match /usage in Claude Code)

# 2. Build, ad-hoc sign, and install the menu-bar app.
make install            # → /Applications/ClaudeTokens.app
open -a ClaudeTokens
```

`make run` builds and launches without installing. `make selftest` runs a
headless Swift→Node→decode check with no UI. Optional: toggle **Open at Login**
from the app's dropdown menu.

To share the app with others, publish a Homebrew tap that builds from source —
see [packaging/homebrew/README.md](packaging/homebrew/README.md).

### SwiftBar plugin (legacy alternative)

```bash
node lib/refresh.js && cat ~/.cache/claude-tokens/usage-*.json   # Always Allow
brew install --cask swiftbar
```

Then point SwiftBar at this repo's `plugins/` folder (or symlink
`plugins/claudetokens.60s.sh` into SwiftBar's plugin directory). Both front-ends
read the same cache, so you can run them side by side while migrating.

## Configuration

`config.json` at the repo root (and bundled into the app):

```json
{ "warnPercent": 80, "criticalPercent": 95 }
```

The ring/bar turns **orange at ≥80% used** and **red at ≥95% used**, and fires a
single notification the first time your 5-hour usage crosses each threshold
(re-armed when the window resets). These are **% used** — higher means closer to
the limit.

If the app can't locate your `node` binary (GUI apps don't inherit your shell
`PATH`), set an absolute path:

```json
{ "warnPercent": 80, "criticalPercent": 95, "nodePath": "/opt/homebrew/bin/node" }
```

The app reads `config.json` from `~/Library/Application Support/ClaudeTokens/`
first, then the copy bundled inside the `.app`.

## Security

- The OAuth token is held **only in memory** and sent **only** to
  `api.anthropic.com` as a Bearer header. It is **never** written to disk,
  logged, or sent anywhere else. See the SECURITY CONTRACT comment in
  [lib/usage-core.js](lib/usage-core.js).
- The on-disk cache (`~/.cache/claude-tokens/usage-<account>.json`) holds only
  percentages, reset timestamps, and your account email — never the token.
- The keychain read is done by Apple's `security` tool, so the app needs no
  keychain entitlement. First run pops a macOS keychain prompt — click
  **Always Allow** so it can read the token unattended.

## Caveats

- **Unofficial endpoint.** `/api/oauth/usage` is not a documented or stable API.
  It may change or break without notice — that's the likely cause if numbers stop
  appearing.
- **Token refresh.** This tool does not refresh expired tokens. The Claude app
  refreshes them in the keychain while it runs, and the tool re-reads the
  keychain on each fetch, so it picks up fresh tokens automatically. If the token
  is expired the bar shows an `auth_expired` note — open Claude to refresh.
- **Desktop-app-only machines.** If Claude is used *only* via the desktop app,
  the keychain item can have an empty `accessToken` (the app keeps the token
  in-process). Log in once with the standalone Claude Code CLI (`claude` →
  `/login`) to populate it.
- **Account switching** is handled: usage is cached per account UUID (from
  `~/.claude.json`), and the bar never shows another account's numbers.

## Architecture

Two front-ends share one Node data core. The **native app** is a thin Swift UI
shell that execs `node lib/status.js`, decodes one JSON blob, and drives the menu
bar. All data + formatting (keychain, API, cache, colours, thresholds, ring PNG)
live in Node.

```
ClaudeTokens.app (Swift, menu-bar accessory — no Dock icon)
  └─ every 60s · on menu open · "Refresh now"
       └─ node lib/status.js        → ONE JSON blob (title, rows, ring, level, notify)
            ├─ lib/render-model.js    shared view model + throttled refresh + formatting
            ├─ lib/usage-core.js      keychain read, API call, per-account cache, ⚠ security contract
            ├─ lib/refresh.js         fetch /api/oauth/usage, write cache
            └─ lib/ring.js            hand-rolled ring-gauge PNG (zlib, zero deps)

SwiftBar (legacy)  → plugins/claudetokens.60s.sh → lib/bar.js  (same model → SwiftBar DSL)
```

**Render and fetch are decoupled**: the front-ends re-render every 60s from cache
(so the countdown ticks each minute), but a real API refetch only fires when the
cache is older than 55s (~once/min). A `429` records the server's `Retry-After`
and back-off is honoured automatically.

Zero third-party dependencies on either side — pure Node standard library and no
Swift packages.

For a deeper map of the code (module responsibilities, the Swift↔Node seam,
conventions, and gotchas), see [CLAUDE.md](CLAUDE.md).
