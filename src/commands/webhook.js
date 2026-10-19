import { parseArgs } from '../args.js';
import { fail, info, success } from '../output.js';
import { c } from '../colors.js';
import { withToken, peekToken } from '../project/credentials.js';
import { getWebhook, syncWebhook } from '../api/endpoints.js';
import { serverErrorText, stripControl } from '../api/client.js';
import { createSpinner } from '../spinner.js';
import { log } from '../logs.js';

function diffSets(actual = [], expected = []) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: expected.filter((x) => !a.has(x)),
    extra: actual.filter((x) => !e.has(x)),
  };
}

export function renderWebhook(wh) {
  const row = (label, value) => console.log('  ' + `${label}:`.padEnd(18) + value);

  console.log(c.dim('Webhook:'));
  row('url', wh.url || c.dim('(none set)'));
  row('allowed updates', (wh.allowed_updates || []).join(', ') || c.dim('(none)'));
  row('pending updates', wh.pending_update_count ?? 0);
  if (wh.last_error_message) {
    // toISOString() throws on an invalid date, so the stamp is checked first.
    let when = '';
    const ts = Number(wh.last_error_date);
    if (Number.isFinite(ts)) {
      const d = new Date(ts * 1000);
      if (!Number.isNaN(d.getTime())) {
        when = ` (${d.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
      }
    }
    row('last error', `${stripControl(wh.last_error_message)}${when}`);
  }

  if (wh.in_sync) {
    console.log(c.green('  ✓ in sync with your deployed handlers'));
    return;
  }

  console.log(c.red('  ✗ OUT OF SYNC with your deployed handlers'));
  const expected = wh.expected || {};
  if (expected.url && expected.url !== wh.url) row('expected url', expected.url);
  const { missing, extra } = diffSets(wh.allowed_updates, expected.allowed_updates);
  if (missing.length || extra.length) row('expected updates', (expected.allowed_updates || []).join(', '));
  console.log('Run "tgpilot webhook sync" to fix.');
}

// tgpilot webhook / tgpilot webhook sync
export async function registerWebhook(argv) {
  const args = parseArgs(argv, {});
  const sub = args.positional[0];

  if (sub === 'sync') {
    const drop = args.flags['drop-pending'] === true;
    try {
      const wh = await withToken(async (token) => {
        const spinner = createSpinner('Syncing webhook…');
        spinner.start();
        try {
          const response = await syncWebhook(token, { drop_pending: drop });
          spinner.stop();
          return response;
        } catch (err) {
          spinner.stop();
          throw err;
        }
      });
      log('info', 'webhook', 'Webhook synced.', { drop_pending: drop, url: wh?.url });
      success('Webhook synced.');
      renderWebhook(wh);
    } catch (err) {
      fail(serverErrorText(err));
      log('error', 'webhook', 'Sync failed.', { error: err?.description || String(err) });
      process.exitCode = 1;
    }
    return 0;
  }

  if (sub !== undefined) {
    fail(`Unknown webhook command "${sub}" — use "tgpilot webhook" or "tgpilot webhook sync".`);
    process.exitCode = 1;
    return 1;
  }

  try {
    const wh = await withToken(async (token) => {
      const spinner = createSpinner('Checking webhook…');
      spinner.start();
      try {
        const response = await getWebhook(token);
        spinner.stop();
        return response;
      } catch (err) {
        spinner.stop();
        throw err;
      }
    });
    renderWebhook(wh);
  } catch (err) {
    fail(serverErrorText(err));
    log('error', 'webhook', 'Status check failed.', { error: err?.description || String(err) });
    process.exitCode = 1;
  }
  return 0;
}

// One-line webhook state for `tgpilot status`. Never throws: returns null on
// any failure (no token, offline, timeout).
export async function webLine() {
  try {
    const token = peekToken();
    if (!token) return null;
    const wh = await Promise.race([
      getWebhook(token),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    if (typeof wh?.in_sync !== 'boolean') return null;
    if (wh.in_sync) return c.dim('Webhook: in sync');
    return c.dim('Webhook: OUT OF SYNC') + '\n' +
      c.yellow('Warning: ') + 'the webhook does not match your handlers. Run "tgpilot webhook sync" to fix.';
  } catch {
    return null;
  }
}
