# Homebrew formula (build-from-source). Publish this to a tap repo named
# `homebrew-claude-tokens` so users can:  brew install <you>/claude-tokens/claude-tokens
#
# Build-from-source means brew compiles the Swift binary on the user's machine,
# so the resulting .app is NOT quarantined and needs no notarization / Developer
# ID. Fill in the two placeholders below after cutting a GitHub release.
class ClaudeTokens < Formula
  desc "macOS menu bar indicator for real Claude subscription usage (5h + weekly)"
  homepage "https://github.com/USER/claude-token-usage-tabbar"
  # TODO: point at your release tarball and paste its sha256
  #   curl -sL <tarball-url> | shasum -a 256
  url "https://github.com/USER/claude-token-usage-tabbar/archive/refs/tags/v2.0.0.tar.gz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node"          # runtime: status.js + refresh.js
  depends_on :macos
  # Swift is used at build time (Command Line Tools is enough — no full Xcode).

  def install
    # Compiles Swift + assembles + ad-hoc signs ClaudeTokens.app.
    system "./scripts/make-app.sh"
    prefix.install "build/ClaudeTokens.app"

    # A small launcher on PATH: `claude-tokens` opens the app.
    (bin/"claude-tokens").write <<~SH
      #!/bin/bash
      exec open "#{prefix}/ClaudeTokens.app"
    SH
  end

  def caveats
    <<~EOS
      ClaudeTokens.app was installed to:
        #{prefix}/ClaudeTokens.app

      For the "Open at Login" toggle to work from a stable path, copy it to /Applications:
        cp -R "#{prefix}/ClaudeTokens.app" /Applications/

      Launch it (menu bar only, no Dock icon):
        claude-tokens      # or:  open -a ClaudeTokens

      Requires the Claude app or Claude Code CLI to have signed in at least once —
      it reads usage via the "Claude Code-credentials" keychain item. On first launch
      click "Always Allow" on the keychain prompt.

      If `brew install` fails in the build sandbox while running swift/codesign, retry:
        brew install --build-from-source --no-sandbox <you>/claude-tokens/claude-tokens
      or just build locally without Homebrew:
        git clone … && cd claude-token-usage-tabbar && make install
    EOS
  end

  test do
    assert_predicate prefix/"ClaudeTokens.app/Contents/MacOS/ClaudeTokens", :exist?
  end
end
