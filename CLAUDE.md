# CLAUDE.md

Guidance for AI agents working in this repo. Read this before editing.

## What this project is

A macOS **menu bar** app that shows a user's real Claude subscription usage
(5-hour + weekly limits) — the same numbers `/usage` reports. It fetches them
from `GET https://api.anthropic.com/api/oauth/usage` using the OAuth token stored
in the `Claude Code-credentials` macOS keychain item. See [README.md](README.md)
for the user-facing overview.

## ⚠️ Security contract — do not weaken

The single most important invariant, enforced in [lib/usage-core.js](lib/usage-core.js):

- The OAuth **access token** is read from the keychain at runtime, held only in
  local variables, and sent **only** to `https://api.anthropic.com` as a `Bearer`
  header. It must **never** be written to disk, logged, printed, put in an error
  message, or sent to any other host.
- The on-disk cache stores **only** derived data — percentages, reset timestamps,
  account UUID/email. Never the token.

Any change that touches token handling, logging, cache contents, or the HTTP
request must preserve this. If a task appears to require weakening it, stop and
flag it to the user.

## Architecture: the Swift ↔ Node seam

Two front-ends, one shared Node core. **All data logic and formatting live in
Node**; Swift is a thin UI shell.

```
Native app (recommended)          SwiftBar plugin (legacy)
ClaudeTokens.app (Swift)          plugins/claudetokens.60s.sh
  └─ execs node lib/status.js       └─ execs node lib/bar.js
       → JSON payload                    → SwiftBar line DSL
              \                          /
               lib/render-model.js  ← builds the neutral view model (buildModel)
               lib/usage-core.js    ← keychain, API, per-account cache, SECURITY CONTRACT
               lib/refresh.js       ← token read + API fetch + cache write
               lib/ring.js          ← ring-gauge PNG, hand-rolled (zlib + CRC32)
```

The contract between Swift and Node is the JSON emitted by `lib/status.js`
(schema version 1), mirrored by the `StatusPayload` struct in
[Sources/ClaudeTokens/StatusPayload.swift](Sources/ClaudeTokens/StatusPayload.swift).
**If you change the payload shape in `status.js`, update `StatusPayload.swift` to
match** (and bump `SCHEMA_VERSION` if the change isn't backward-compatible). Every
field on the Swift side is optional so partial/future payloads still decode.

## File map

### Node (`lib/`) — zero dependencies, pure stdlib

| File | Responsibility |
|------|----------------|
| `usage-core.js` | Keychain read, `/api/oauth/usage` call, per-account cache, response normalization. **Holds the security contract.** |
| `render-model.js` | Shared: config loader, throttled-refresh trigger (`maybeRefresh`), formatting helpers, and `buildModel()` — the neutral view model both front-ends serialize. No I/O in `buildModel` itself. |
| `status.js` | Native-app entry. Emits ONE JSON object to stdout, **always valid even on error** (`state:"error"`). Never writes stderr. |
| `bar.js` | SwiftBar entry. Serializes the same model to SwiftBar's line DSL; keeps the legacy `osascript` notification. |
| `refresh.js` | Standalone fetch → cache writer. Records `last_error` / `rate_limited_until` into the cache on failure. |
| `ring.js` | Renders the circular usage-ring PNG from scratch (no image libs). |

### Swift (`Sources/ClaudeTokens/`)

| File | Responsibility |
|------|----------------|
| `main.swift` | Accessory-app bootstrap (no Dock icon). |
| `AppDelegate.swift` | Status item + menu, 60s render tick, refresh coalescing, self-test. |
| `NodeRunner.swift` | Runs `node <script>` off-main-thread; drains stdout/stderr concurrently (avoids the 64KB pipe deadlock); 15s watchdog. |
| `NodeLocator.swift` | Finds `node` for a GUI app that lacks the shell `PATH` (config override → login-shell probe → candidate scan). |
| `Config.swift` | Reads the optional `nodePath` override from `config.json`. |
| `Notifier.swift` | Native threshold notifications via `UNUserNotificationCenter`. |
| `StatusPayload.swift` | Decodable mirror of the `status.js` JSON contract. |
| `NSColor+Hex.swift` | `#rrggbb` → `NSColor`. |

## Commands

```bash
make app        # build + assemble build/ClaudeTokens.app (ad-hoc signed)
make install    # build + install to /Applications
make run        # build + launch (no install)
make selftest   # headless Swift→Node→decode pipeline check (no UI)
make uninstall  # remove from /Applications
make clean      # remove .build and build/

# Node layer directly (useful for debugging the data path):
node lib/status.js      # print the JSON payload the app consumes
node lib/refresh.js     # force a fetch + cache write (prints ok / error reason)
node lib/bar.js         # print the SwiftBar DSL
```

There is **no automated test suite** and **no linter/formatter config**. The
`render()` / `buildPayload()` functions are exported specifically so they're
pure and easy to reason about; `make selftest` is the closest thing to an
integration test.

## Conventions

- **Node:** CommonJS (`require`), `'use strict'`, `node:` import prefix, pure
  stdlib only. Keep it dependency-free — do not add npm packages.
- **Swift:** SwiftPM executable target, no third-party packages. macOS 13+ APIs
  are fine (`SMAppService`).
- Match the existing comment density — this codebase favours a short explanatory
  comment on any non-obvious decision (why, not what). Preserve those.
- Keep pure functions pure: `buildModel`, `buildPayload`, and `render` must not
  do I/O or spawn processes.

## Key behaviours & gotchas

- **Render vs. fetch are decoupled.** Front-ends re-render every 60s from cache
  (keeps the "resets in …" countdown live) but `maybeRefresh` only spawns a real
  network fetch when the cache is older than `REFRESH_AFTER_S` (55s). Don't
  couple them.
- **429 back-off is server-directed.** A 429 writes `rate_limited_until` (from
  `Retry-After`, else +5min) into the cache; `maybeRefresh` skips fetching until
  it passes. Don't replace this with a guessed fixed rate.
- **Per-account cache.** Keyed by account UUID from `~/.claude.json`
  (`usage-<uuid>.json`). The bar must never show another account's numbers after
  a switch — it shows a placeholder until the new account's data arrives.
- **GUI PATH problem.** A Finder/Login-Item-launched app inherits only launchd's
  minimal PATH. `NodeLocator` and the explicit `PATH` set in `NodeRunner` exist
  to solve this — needed so Node's own children (`security`, `refresh.js`)
  resolve. Keep both.
- **`status.js` must never fail loudly.** It always prints one valid JSON object
  and exits 0; the Swift side treats stdout as authoritative and ignores stderr.
- **Ring image is not a template.** Its colour encodes warn/critical level, so
  `isTemplate` must stay `false` (macOS must not tint it).
- **Empty `accessToken`** in the keychain is a known state on desktop-app-only
  machines — surfaced as a helpful error, not a crash. Preserve that path.

## When making changes

- Changing the display model → update `buildModel` in `render-model.js`; both
  front-ends inherit it automatically.
- Changing the JSON payload → update `status.js` **and** `StatusPayload.swift`.
- Adding a config key → wire it in `loadConfig` (`render-model.js`) and, if Swift
  needs it, in `Config.swift`.
- Bumping the version → `package.json` `version` (the build script reads it into
  the app's `Info.plist`).
- After Swift changes, run `make selftest` to confirm the pipeline still decodes.
