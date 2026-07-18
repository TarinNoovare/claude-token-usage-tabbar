# Publishing via a Homebrew tap (build-from-source, free)

This installs ClaudeTokens by **compiling it on the user's machine**, so the app
is never downloaded as a prebuilt binary — it isn't quarantined by Gatekeeper and
needs **no notarization and no paid Apple Developer ID**.

## One-time setup (maintainer)

1. Push this repo to GitHub and cut a tagged release, e.g. `v2.0.0`.
2. Get the tarball checksum:
   ```bash
   curl -sL https://github.com/USER/claude-token-usage-tabbar/archive/refs/tags/v2.0.0.tar.gz | shasum -a 256
   ```
3. Create a second repo named **`homebrew-claude-tokens`** and put
   [`claude-tokens.rb`](claude-tokens.rb) in a `Formula/` directory, with `USER`,
   the `url`, and `sha256` filled in.

## Users install with

```bash
brew install USER/claude-tokens/claude-tokens
cp -R "$(brew --prefix)/opt/claude-tokens/ClaudeTokens.app" /Applications/   # optional
open -a ClaudeTokens
```

## Notes / caveats

- **Node is a dependency** (`depends_on "node"`) — the app is a thin Swift shell
  that execs `node lib/status.js`. Brew installs Node automatically.
- **Swift toolchain** comes from the Command Line Tools; full Xcode is not
  required. If Homebrew's build sandbox blocks `swift`/`codesign`, users can add
  `--no-sandbox`, or skip brew entirely and run `make install` from a clone.
- A GUI `.app` shipped via a *formula* (not a *cask*) is the standard workaround
  for free build-from-source distribution: casks expect a prebuilt, downloaded
  (therefore quarantined) artifact.
