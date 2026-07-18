#!/usr/bin/env node
'use strict';

// SwiftBar entry point. Renders real Claude usage from the per-account cache,
// triggering a throttled refresh (lib/refresh.js) when the cache is stale.
// Never throws: any failure degrades to a readable menu-bar line.
//
// The view model and refresh logic are shared with lib/status.js (the native
// Swift app) via lib/render-model.js. This file only serializes that neutral
// model into SwiftBar's line DSL, and keeps the legacy osascript notification
// (the Swift app notifies natively instead).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./usage-core');
const ring = require('./ring');
const rm = require('./render-model');

const NOTIFIED_PATH = path.join(core.CACHE_DIR, 'notified.json');

// --- notification on crossing a "used" threshold upward (legacy: SwiftBar only) ---

function maybeNotify(account, fiveHour, config) {
  if (!fiveHour || fiveHour.used_percentage == null) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(NOTIFIED_PATH, 'utf8'));
  } catch {
    state = {};
  }
  // key notifications per account + reset window, so a new window re-arms them
  const windowKey = `${account.uuid}:${fiveHour.resets_at || 0}`;
  if (state.windowKey !== windowKey) state = { windowKey, lastLevel: 'ok' };

  const level = rm.levelForUsed(fiveHour.used_percentage, config);
  if (rm.LEVEL_RANK[level] > rm.LEVEL_RANK[state.lastLevel]) {
    const pct = Math.round(fiveHour.used_percentage);
    const resetTxt = fiveHour.resets_at ? ` · reset ${rm.fmtClock(fiveHour.resets_at)}` : '';
    try {
      execFileSync('osascript', [
        '-e',
        `display notification "5h limit ${pct}% used${resetTxt}" with title "Claude tokens"`,
      ]);
    } catch { /* ignore */ }
    state.lastLevel = level;
  } else if (rm.LEVEL_RANK[level] < rm.LEVEL_RANK[state.lastLevel]) {
    state.lastLevel = level;
  }
  try {
    fs.mkdirSync(core.CACHE_DIR, { recursive: true });
    fs.writeFileSync(NOTIFIED_PATH, JSON.stringify(state));
  } catch { /* ignore */ }
}

// --- SwiftBar serialization ---

// One neutral model row → one SwiftBar line. `text | key=val key=val`; a row
// with no params emits just the text; a { separator:true } row emits '---'.
function swiftBarRow(row) {
  if (row.separator) return '---';
  const params = [];
  if (row.mono) params.push('font=Menlo size=13');
  if (row.color) params.push(`color=${row.color}`);
  return params.length ? `${row.text} | ${params.join(' ')}` : row.text;
}

// Pure: neutral view model → SwiftBar text. Exported for regression testing.
function render(account, cache, config, nowS) {
  const model = rm.buildModel(account, cache, config, nowS);
  const lines = [];
  lines.push(
    model.ring
      ? `${model.title} | image=${ring.ringPngBase64(model.ring.pct, model.ring.color, 36)}`
      : model.title
  );
  lines.push('---');
  for (const row of model.rows) lines.push(swiftBarRow(row));
  lines.push(`${model.refreshLabel} | refresh=true`);
  return lines.join('\n');
}

function main() {
  const config = rm.loadConfig();
  const account = core.readAccount();
  if (account) rm.maybeRefresh(account);
  const cache = account ? core.readCache(account.uuid) : null;
  const nowS = Math.floor(Date.now() / 1000);

  process.stdout.write(render(account, cache, config, nowS) + '\n');

  // Fire the threshold notification for the 5-hour window (SwiftBar path only).
  if (account && cache && cache.five_hour) maybeNotify(account, cache.five_hour, config);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err)).split('\n')[0].slice(0, 160);
    process.stdout.write('⛁ —\n---\nbar.js error\n' + msg + '\nRefresh | refresh=true\n');
  }
}

module.exports = { render };
