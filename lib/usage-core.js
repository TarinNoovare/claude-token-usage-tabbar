'use strict';

// Core logic for reading the Claude subscription OAuth token and fetching real
// usage/quota data from the same endpoint Claude Code's `/usage` command uses.
//
// SECURITY CONTRACT (do not weaken):
//   - The OAuth access token is read from the macOS keychain at runtime, held
//     only in local variables, and sent ONLY to https://api.anthropic.com as a
//     Bearer header. It is never written to disk, logged, or sent anywhere else.
//   - The on-disk cache (usage-<account>.json) stores ONLY the resulting
//     percentages / reset timestamps / account email — never the token.

const { execFileSync, spawnSync } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const API_HOST = 'api.anthropic.com';
const API_PATH = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'claude-tokens');

// --- account identity (from ~/.claude.json, updated by the app on switch) ---

function readAccount() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const a = raw && raw.oauthAccount;
    if (!a || !a.accountUuid) return null;
    return { uuid: a.accountUuid, email: a.emailAddress || null };
  } catch {
    return null;
  }
}

// --- credentials (keychain only; never returned to callers as raw values) ---

// Read one 'Claude Code-credentials' generic-password blob. When `keychain` is
// given, the search is scoped to that keychain file; otherwise it uses the
// default search list. Returns the raw password string, or null if this call
// found nothing / could not read (status != 0). Never throws.
function readCredentialBlob(keychain) {
  const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'];
  if (keychain) args.push(keychain);
  let r;
  try {
    r = spawnSync('security', args, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024, // credentials blob can be large (mcpOAuth entries)
    });
  } catch {
    return null;
  }
  if (!r || r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

// Pull the OAuth token out of a credentials blob, or null if it isn't there.
function extractOAuth(blob) {
  if (!blob) return null;
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { parsed: false, oauth: null };
  }
  const oauth = parsed && parsed.claudeAiOauth;
  if (oauth && oauth.accessToken) {
    return { parsed: true, oauth: { token: oauth.accessToken, expiresAt: oauth.expiresAt || null } };
  }
  return { parsed: true, oauth: null };
}

// The keychains on the user's search list (quoted paths, one per line).
function keychainSearchList() {
  try {
    const out = execFileSync('security', ['list-keychains', '-d', 'user'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out
      .split('\n')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readAccessToken() {
  // Probe the login keychain, then the rest of the search list, and take the
  // first 'Claude Code-credentials' blob that actually carries an accessToken.
  const login = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  const candidates = [login, ...keychainSearchList(), null];

  const tried = new Set();
  let sawEmptyToken = false;
  for (const kc of candidates) {
    const key = kc === null ? '<default>' : kc;
    if (tried.has(key)) continue;
    tried.add(key);

    const res = extractOAuth(readCredentialBlob(kc));
    if (res && res.oauth) return res.oauth;
    if (res && res.parsed && !res.oauth) sawEmptyToken = true;
  }

  if (sawEmptyToken) {
    // The keychain item exists but its accessToken is empty. This is the state on
    // machines where Claude runs via the DESKTOP APP (agent mode): the app keeps
    // the OAuth token in its own host process and never writes it to the keychain
    // slot. The standalone Claude Code CLI (`claude` → /login) is what populates it.
    const e = new Error('token_empty');
    e.detail =
      'The "Claude Code-credentials" keychain item has an empty accessToken — the desktop app ' +
      'keeps the token in-process and does not write it here. Log in with the standalone Claude Code CLI to populate it.';
    throw e;
  }
  throw new Error('no_access_token');
}

// --- API call ---

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: API_PATH,
        method: 'GET',
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'Content-Type': 'application/json',
          'User-Agent': 'claude-token-usage-tabbar',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            const e = new Error('auth_expired');
            e.statusCode = res.statusCode;
            return reject(e);
          }
          if (res.statusCode === 429) {
            const e = new Error('rate_limited');
            e.statusCode = 429;
            // Honor the server's own back-off guidance if present. Retry-After
            // is either a number of seconds or an HTTP-date; parse both.
            const ra = res.headers['retry-after'];
            if (ra != null) {
              const s = String(ra).trim();
              const secs = /^\d+$/.test(s)
                ? parseInt(s, 10)
                : Math.floor((Date.parse(s) - Date.now()) / 1000);
              if (Number.isFinite(secs) && secs >= 0) e.retryAfterS = secs;
            }
            return reject(e);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const e = new Error(`http_${res.statusCode}`);
            e.statusCode = res.statusCode;
            return reject(e);
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('response_parse_failed'));
          }
        });
      }
    );
    req.on('error', (err) => reject(new Error('network_error: ' + (err.code || err.message))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request_timeout'));
    });
    req.end();
  });
}

// --- cache (percentages only, keyed per account) ---

function cachePathFor(accountUuid) {
  return path.join(CACHE_DIR, `usage-${accountUuid}.json`);
}

function writeCacheAtomic(accountUuid, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const target = cachePathFor(accountUuid);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target); // atomic on same filesystem
}

function readCache(accountUuid) {
  try {
    return JSON.parse(fs.readFileSync(cachePathFor(accountUuid), 'utf8'));
  } catch {
    return null;
  }
}

// Normalize the API response (utilization + resets_at ISO string) into the
// shape the bar renders. Only keeps the windows we display.
function normalizeUsage(apiResponse, account) {
  const pickWindow = (w) => {
    if (!w || typeof w.utilization !== 'number') return null;
    const resetsAtMs = w.resets_at ? Date.parse(w.resets_at) : null;
    return {
      used_percentage: w.utilization,
      resets_at: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : null,
    };
  };
  return {
    account_uuid: account.uuid,
    account_email: account.email,
    five_hour: pickWindow(apiResponse.five_hour),
    seven_day: pickWindow(apiResponse.seven_day),
    seven_day_opus: pickWindow(apiResponse.seven_day_opus),
    seven_day_sonnet: pickWindow(apiResponse.seven_day_sonnet),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

module.exports = {
  CACHE_DIR,
  readAccount,
  readAccessToken,
  fetchUsage,
  normalizeUsage,
  writeCacheAtomic,
  readCache,
  cachePathFor,
};
