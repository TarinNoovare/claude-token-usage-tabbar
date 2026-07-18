# ClaudeTokens — build/install the native menu bar app (Swift wrapping Node).
# Requires: Swift toolchain (Command Line Tools) and Node 18+.

APP := build/ClaudeTokens.app

.PHONY: app install uninstall run selftest clean

app: ## Build and assemble build/ClaudeTokens.app (ad-hoc signed)
	./scripts/make-app.sh

install: app ## Install to /Applications
	rm -rf /Applications/ClaudeTokens.app
	cp -R "$(APP)" /Applications/
	@echo "Installed → /Applications/ClaudeTokens.app  (open it, or: open -a ClaudeTokens)"

uninstall: ## Remove from /Applications
	rm -rf /Applications/ClaudeTokens.app

run: app ## Build, assemble, and launch
	open "$(APP)"

selftest: ## Headless pipeline check (no UI): Swift → node status.js → decode
	swift build -c release --disable-sandbox
	CLAUDE_TOKENS_SELFTEST=1 CLAUDE_TOKENS_LIB="$(PWD)/lib" "$$(swift build -c release --show-bin-path)/ClaudeTokens"

clean: ## Remove build artifacts
	rm -rf .build build
