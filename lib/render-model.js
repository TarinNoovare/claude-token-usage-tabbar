'use strict';

// Shared logic between the two menu renderers: lib/bar.js (SwiftBar plugin) and
// lib/status.js (native Swift app). It owns everything the two renderers have in
// common — the config loader, the throttled-refresh trigger, the monospaced
// layout helpers, and buildModel(), which turns the per-account cache into a
// neutral "view model" with NO output-format assumptions. Each renderer then
// serializes that model its own way (SwiftBar line DSL vs JSON).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./usage-core');

const PROJECT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const REFRESH_SCRIPT = path.join(__dirname, 'refresh.js');

// Throttle for the actual network refetch — DECOUPLED from render cadence.
// The front-ends re-render every 60s (cheap, cache-only; keeps the "resets in …"
// countdown ticking every minute), but maybeRefresh only spawns refresh.js when
// the cache is older than this. 55s is just under the 60s render tick, so each
// tick refetches — the practical floor, since /api/oauth/usage is a per-minute-ish
// stats read. We don't guess a safe rate: if the server ever returns HTTP 429 we
// honor its Retry-After via cache.rate_limited_until (see maybeRefresh), so this
// can sit at ~1 min and back off automatically only when actually told to.
const REFRESH_AFTER_S = 55;
const REFRESH_TIMEOUT_MS = 9000;

function loadConfig() {
  const defaults = { warnPercent: 80, criticalPercent: 95 };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return defaults;
  }
}

// Spawn refresh.js if the cache is older than REFRESH_AFTER_S. Best-effort:
// refresh failures surface later via the cache's last_error, so we ignore here.
function maybeRefresh(account) {
  const cache = core.readCache(account.uuid);
  const nowS = Math.floor(Date.now() / 1000);
  // Server-directed back-off after a 429 wins over the normal cadence.
  if (cache && cache.rate_limited_until && nowS < cache.rate_limited_until) return;
  const ageS = cache && cache.updated_at ? nowS - cache.updated_at : Infinity;
  if (ageS < REFRESH_AFTER_S) return; // fresh enough
  try {
    spawnSync(process.execPath, [REFRESH_SCRIPT], { timeout: REFRESH_TIMEOUT_MS, stdio: 'ignore' });
  } catch {
    // ignore; the cache's last_error carries any failure detail
  }
}

// --- time / level helpers ---

function fmtDuration(sec) {
  if (sec <= 0) return 'now';
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function fmtClock(epochS) {
  return new Date(epochS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtResetDay(epochS) {
  return new Date(epochS * 1000).toLocaleString([], {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

const LEVEL_RANK = { ok: 0, warn: 1, critical: 2 };

function levelForUsed(usedPct, config) {
  if (usedPct == null) return 'ok';
  if (usedPct >= config.criticalPercent) return 'critical';
  if (usedPct >= config.warnPercent) return 'warn';
  return 'ok';
}

// --- monospaced bar layout (Menlo, so 1 char == 1 column) ---

const BAR_WIDTH = 36;
const COLS = BAR_WIDTH + 2 + 4; // bar + "  " + "100%"

function drawBar(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function barColor(usedPct, config) {
  if (usedPct >= config.criticalPercent) return '#e74c3c'; // red
  if (usedPct >= config.warnPercent) return '#e67e22'; // orange
  return '#4a90d9'; // blue (like the app)
}

// One usage window → 1 row (missing) or 2 rows (header + colored bar), each a
// neutral { text, color, mono } object. `mono` marks Menlo/monospaced rows.
// The trailing space in the "missing" text is intentional: it reproduces the
// original SwiftBar template byte-for-byte once the " | " separator is added.
function windowRows(label, w, config, nowS) {
  if (!w || w.used_percentage == null) {
    return [{ text: `${label}  — `, color: '#888888', mono: true }];
  }
  const pct = Math.round(w.used_percentage);

  let reset;
  if (w.resets_at && nowS >= w.resets_at) {
    reset = 'reset · refreshing';
  } else if (w.resets_at) {
    // weekly windows are far out → show the day; short windows → countdown
    reset = w.resets_at - nowS > 24 * 3600
      ? `resets ${fmtResetDay(w.resets_at)}`
      : `resets in ${fmtDuration(w.resets_at - nowS)}`;
  } else {
    reset = '';
  }

  const pad = Math.max(1, COLS - label.length - reset.length);
  const header = label + ' '.repeat(pad) + reset;
  const barLine = `${drawBar(pct)}  ${(pct + '%').padStart(4)}`;
  return [
    { text: header, color: '#cccccc', mono: true },
    { text: barLine, color: barColor(pct, config), mono: true },
  ];
}

// Build the neutral view model from account + cache. Pure: no I/O, no spawning.
// Shape:
//   {
//     state: 'no_account' | 'no_data' | 'ok',
//     title: string,                 // menu-bar text ('⛁ —' / '⛁ …' / '15% · 4h28m')
//     ring: { pct, color } | null,   // ring inputs (present only when data exists)
//     level: 'ok' | 'warn' | 'critical',
//     rows: [ { text, color?, mono? } | { separator: true } ],  // dropdown body + footer
//     account: { email, uuid } | null,
//     updatedAt: number | null,
//     lastError: string | null,
//     lastErrorDetail: string | null,
//     notify: { windowKey, level, text } | null,
//     refreshLabel: string,          // interactive control label the renderer appends
//     hasFooter: boolean,
//   }
function buildModel(account, cache, config, nowS) {
  if (!account) {
    return {
      state: 'no_account',
      title: '⛁ —',
      ring: null,
      level: 'ok',
      rows: [{ text: 'Not signed in to Claude' }],
      account: null,
      updatedAt: null,
      lastError: null,
      lastErrorDetail: null,
      notify: null,
      refreshLabel: 'Refresh',
      hasFooter: false,
    };
  }

  const rows = [];
  let title;
  let ring = null;
  let level = 'ok';
  let notify = null;
  let state;

  if (!cache || !cache.five_hour) {
    state = 'no_data';
    title = '⛁ …';
    rows.push({ text: 'No usage data yet' });
    if (cache && cache.last_error) rows.push({ text: `Last error: ${cache.last_error}`, color: '#c0392b' });
    if (cache && cache.last_error_detail) rows.push({ text: cache.last_error_detail, color: '#888888' });
    rows.push({ text: 'Open Claude Code, then refresh' });
  } else {
    state = 'ok';
    const fh = cache.five_hour;
    const used = fh.used_percentage;
    const usedRounded = used == null ? null : Math.round(used);

    if (fh.resets_at && nowS >= fh.resets_at) {
      title = '~0%';
      ring = { pct: 0, color: '#4a90d9' };
    } else {
      const remain = fh.resets_at ? fmtDuration(fh.resets_at - nowS) : '?';
      title = `${usedRounded}% · ${remain}`;
      // The ring carries the colour; the % text stays default so it adapts to the bar.
      ring = { pct: used == null ? 0 : used, color: barColor(used, config) };
    }
    level = levelForUsed(used, config);

    const updatedSuffix = cache && cache.updated_at ? ` · Updated ${fmtClock(cache.updated_at)}` : '';
    rows.push({ text: `Your usage limits${updatedSuffix}`, color: '#888888' });
    rows.push(...windowRows('5-hour limit', cache.five_hour, config, nowS));
    rows.push(...windowRows('Weekly · all', cache.seven_day, config, nowS));
    if (cache.seven_day_opus) rows.push(...windowRows('Weekly · Opus', cache.seven_day_opus, config, nowS));

    // Raw signal for notifications. bar.js fires its own (osascript); the Swift
    // app reads this and decides via UNUserNotificationCenter.
    const windowKey = `${account.uuid}:${fh.resets_at || 0}`;
    const pctTxt = usedRounded == null ? '?' : usedRounded;
    const resetTxt = fh.resets_at ? ` · reset ${fmtClock(fh.resets_at)}` : '';
    notify = { windowKey, level, text: `5h limit ${pctTxt}% used${resetTxt}` };
  }

  // Footer — common to no_data and ok (no_account returned early above).
  rows.push({ separator: true });
  if (state !== 'ok' && cache && cache.updated_at) rows.push({ text: `Updated: ${fmtClock(cache.updated_at)}`, color: '#888888' });
  if (cache && cache.last_error) rows.push({ text: `⚠️ ${cache.last_error}`, color: '#888888' });

  return {
    state,
    title,
    ring,
    level,
    rows,
    account: { email: account.email, uuid: account.uuid },
    updatedAt: cache && cache.updated_at ? cache.updated_at : null,
    lastError: cache && cache.last_error ? cache.last_error : null,
    lastErrorDetail: cache && cache.last_error_detail ? cache.last_error_detail : null,
    notify,
    refreshLabel: 'Refresh now',
    hasFooter: true,
  };
}

module.exports = {
  REFRESH_AFTER_S,
  loadConfig,
  maybeRefresh,
  buildModel,
  barColor,
  levelForUsed,
  LEVEL_RANK,
  fmtClock,
  fmtDuration,
};
