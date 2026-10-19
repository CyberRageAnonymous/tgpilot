import fs from 'fs';
import { loadCredentials, saveCredentials, deleteCredentials, ensureStateDir } from './state.js';
import { fatal } from '../output.js';
import { extractAppId, request } from '../api/client.js';
import { plain } from '../colors.js';
import { log } from '../logs.js';

const TOKEN_FORMAT = /^app\d+:[A-Za-z0-9_-]+$/;
const ENV_NAMES = ['TGPILOT_TOKEN', 'TGCLOUD_TOKEN'];

function usedEnvName() {
  return ENV_NAMES.find((name) => process.env[name]) || null;
}

export function tokenEnvName() {
  return usedEnvName();
}

export function isValidFormat(token) {
  return TOKEN_FORMAT.test(String(token || ''));
}

// The printable half of a token: the app id. The secret part is never shown.
export function maskToken(token) {
  if (!token) return '';
  const colon = token.indexOf(':');
  if (colon <= 0) return '…' + token.slice(-4);
  return token.slice(0, colon);
}

// A token must resolve without prompting outside of login, so: env first,
// then the saved credentials; otherwise a clear stop.
export function resolveToken() {
  const envName = usedEnvName();
  if (envName) {
    const token = process.env[envName];
    if (!isValidFormat(token)) {
      fatal(`${envName}: the value does not look like an access token (expected "app<id>:<secret>").`);
    }
    return token;
  }

  const creds = loadCredentials();
  if (creds?.token) return creds.token;

  fatal('No access token for this project yet. Run "tgpilot login", or set TGPILOT_TOKEN (handy in CI).');
}

export function peekToken() {
  const envName = usedEnvName();
  if (envName) {
    const token = process.env[envName];
    return isValidFormat(token) ? token : null;
  }
  return loadCredentials()?.token || null;
}

export function isAuthError(err) {
  return err?.status === 401 || err?.status === 403;
}

// Runs fn(token) once; a 401/403 means the bot and this folder are no longer a
// pair, so the saved token is dropped and the user is sent back to login.
export async function withToken(fn) {
  const token = resolveToken();
  try {
    return await fn(token);
  } catch (err) {
    if (!isAuthError(err)) throw err;

    const reason = err.description || 'the token was rejected';

    const envName = usedEnvName();
    if (envName && process.env[envName]) {
      fatal(`${envName} (${maskToken(process.env[envName])}): ${plain(reason)}.`);
    }

    const expired = loadCredentials();
    deleteCredentials();
    log('warn', 'auth', 'Saved token rejected by the server; project unlinked.', { token: maskToken(expired?.token) });
    fatal(
      `The saved token${expired?.token ? ` for ${maskToken(expired.token)}` : ''} was rejected: ${plain(reason)}.\n` +
      '  Run "tgpilot login" to link this project again.'
    );
  }
}

// Anything that is not an auth or network failure counts as fine: the token
// works, whatever this particular call answered.
export async function verifyToken(token) {
  try {
    extractAppId(token); // bad token shapes unlock the rejection below
    await request('GET', '/get', token);
    return { ok: true, network: false };
  } catch (err) {
    if (err instanceof Error && /Invalid token format/.test(err.message)) {
      return { ok: false, network: false };
    }
    if (isAuthError(err)) return { ok: false, network: false };
    if (err.status == null) return { ok: false, network: true };
    return { ok: true, network: false };
  }
}

// Loops until a working token is saved, the terminal closes, or the user is
// done. The only place a token is ever asked for.
export async function loginInteractive(prompt) {
  if (process.stdin.isTTY !== true) {
    console.error('"tgpilot login" needs an interactive terminal. For scripts, set TGPILOT_TOKEN instead.');
    return null;
  }

  console.log('This links the project folder to your bot.');
  console.log('Get the access token from @BotFather: your bot → Serverless → CLI Access → Access token.');
  if (usedEnvName() && process.env[usedEnvName()]) {
    console.log(`Note: ${usedEnvName()} is set and outranks the token stored here.`);
  }
  console.log('');

  let promptCount = 0;
  for (;;) {
    const raw = await prompt('Paste the access token (stays hidden): ');
    if (promptCount++ > 64) return null;

    if (raw === null) {
      console.error('\nNo token received (input closed). For scripts, set TGPILOT_TOKEN instead.');
      return null;
    }
    const token = String(raw).trim();

    if (!token) {
      console.error('  A token is required.');
      continue;
    }
    if (!isValidFormat(token)) {
      console.error('  That does not look like an access token — expected "app<id>:<secret>".');
      continue;
    }

    const check = await verifyToken(token);
    if (check.ok) {
      saveCredentials(token);
      console.log(`  Linked to ${maskToken(token)}.`);
      log('info', 'login', 'Project linked to a bot.', { token: maskToken(token) });
      return token;
    }
    if (check.network) {
      saveCredentials(token);
      console.log('  The server is unreachable, so the token was saved without verification.');
      console.log('  The next online command will confirm it.');
      log('warn', 'login', 'Token saved but not verified (network unreachable).', { token: maskToken(token) });
      return token;
    }
    console.error('  The server rejected that token.');
    console.error('  Get a fresh one from @BotFather: your bot → Serverless → CLI Access → Access token.');
  }
}

export function unlinkBot() {
  if (loadCredentials() == null) return false;
  deleteCredentials();
  ensureStateDir();
  return true;
}
