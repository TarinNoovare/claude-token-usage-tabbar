#!/usr/bin/env node
'use strict';

// Fetches real usage from the OAuth endpoint and writes it to the per-account
// cache. Run standalone or invoked by bar.js when the cache is stale.
// Exits 0 on success, non-zero on failure (with a short reason on stderr).

const core = require('./usage-core');

async function main() {
  const account = core.readAccount();
  if (!account) {
    process.stderr.write('no_account\n');
    process.exit(2);
  }

  let cred;
  try {
    cred = core.readAccessToken();
  } catch (err) {
    // Record token-read failures into the cache too, so the bar can explain why
    // there's no data instead of silently showing "No usage data yet".
    const prev = core.readCache(account.uuid) || { account_uuid: account.uuid, account_email: account.email };
    prev.last_error = (err.message || 'token_error').slice(0, 80);
    if (err.detail) prev.last_error_detail = String(err.detail).slice(0, 200);
    prev.last_error_at = Math.floor(Date.now() / 1000);
    try {
      core.writeCacheAtomic(account.uuid, prev);
    } catch {
      // ignore secondary write failure
    }
    process.stderr.write((err.message || 'token_error') + '\n');
    process.exit(3);
  }

  try {
    const raw = await core.fetchUsage(cred.token);
    const normalized = core.normalizeUsage(raw, account);
    core.writeCacheAtomic(account.uuid, normalized);
    process.stdout.write('ok\n');
    process.exit(0);
  } catch (err) {
    // Record the failure into the cache envelope (without clobbering the last
    // good numbers) so the bar can show an accurate staleness/error state.
    const nowS = Math.floor(Date.now() / 1000);
    const prev = core.readCache(account.uuid) || { account_uuid: account.uuid, account_email: account.email };
    prev.last_error = (err.message || 'fetch_failed').slice(0, 80);
    prev.last_error_at = nowS;
    // On a 429, set an explicit back-off deadline that maybeRefresh honors:
    // use the server's Retry-After when given, else a conservative 5 min.
    if (err.statusCode === 429) {
      const backoff = Number.isFinite(err.retryAfterS) ? err.retryAfterS : 300;
      prev.rate_limited_until = nowS + backoff;
    }
    try {
      core.writeCacheAtomic(account.uuid, prev);
    } catch {
      // ignore secondary write failure
    }
    process.stderr.write((err.message || 'fetch_failed') + '\n');
    process.exit(1);
  }
}

main();
