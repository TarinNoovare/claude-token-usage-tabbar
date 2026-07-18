#!/usr/bin/env node
'use strict';

// Entry point for the native Swift menu-bar app (ClaudeTokens.app). Same data
// path as bar.js — read account, throttled-refresh the per-account cache, build
// the shared view model — but serialized as ONE JSON object to stdout instead
// of SwiftBar's line DSL. The Swift app decodes it to drive NSStatusItem/NSMenu
// and its own UNUserNotificationCenter notifications.
//
// CONTRACT: this script always prints ONE valid JSON object and exits 0, even on
// internal failure (state:"error" with lastError). It never throws to the caller
// and never writes to stderr — the Swift side treats stdout as authoritative.

const core = require('./usage-core');
const ring = require('./ring');
const rm = require('./render-model');

const SCHEMA_VERSION = 1;

// Pure: neutral view model → JSON payload. Exported for testing.
function buildPayload(account, cache, config, nowS) {
  const model = rm.buildModel(account, cache, config, nowS);
  return {
    schemaVersion: SCHEMA_VERSION,
    state: model.state, // 'no_account' | 'no_data' | 'ok'
    title: model.title, // menu-bar text ('⛁ —' / '⛁ …' / '15% · 4h28m')
    // Ring PNG with the warn/critical colour baked in (Swift wraps as NSImage
    // and must NOT set isTemplate). Null when there's no data to draw.
    ringPngBase64: model.ring ? ring.ringPngBase64(model.ring.pct, model.ring.color, 36) : null,
    level: model.level, // 'ok' | 'warn' | 'critical'
    rows: model.rows, // [{ text, color?, mono? } | { separator:true }] — dropdown body + footer
    account: model.account, // { email, uuid } | null
    updatedAt: model.updatedAt, // epoch seconds | null
    lastError: model.lastError,
    lastErrorDetail: model.lastErrorDetail,
    notify: model.notify, // { windowKey, level, text } | null — Swift decides whether to fire
  };
}

function main() {
  const config = rm.loadConfig();
  const account = core.readAccount();
  if (account) rm.maybeRefresh(account);
  const cache = account ? core.readCache(account.uuid) : null;
  const nowS = Math.floor(Date.now() / 1000);
  process.stdout.write(JSON.stringify(buildPayload(account, cache, config, nowS)) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err)).split('\n')[0].slice(0, 200);
    process.stdout.write(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        state: 'error',
        title: '⛁ —',
        ringPngBase64: null,
        level: 'ok',
        rows: [{ text: 'status.js error' }, { text: msg, color: '#c0392b' }],
        account: null,
        updatedAt: null,
        lastError: msg,
        lastErrorDetail: null,
        notify: null,
      }) + '\n'
    );
  }
}

module.exports = { buildPayload, SCHEMA_VERSION };
