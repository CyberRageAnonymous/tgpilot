import fs from 'fs';
import { loadCredentials, saveCredentials, deleteCredentials, ensureStateDir, loadProfiles, saveProfiles, setCurrentProfile, DEFAULT_PROFILE } from './state.js';
import { fatal } from '../output.js';
import { extractAppId, request } from '../api/client.js';
import { saveWorkspace, restoreWorkspace } from './workspace.js';
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

  const token = activeToken();
  if (token) return token;

  fatal('No access token for this project yet. Run "tgpilot login", or set TGPILOT_TOKEN (handy in CI).');
}

// The token of the profile that is active right now. Profiles let one folder
// talk to several bots; the active one decides.
export function activeProfile() {
  return loadProfiles().active;
}

export function activeToken() {
  const { active, profiles } = loadProfiles();
  if (active && profiles[active]?.token) return profiles[active].token;
  return loadCredentials()?.token || null;
}

export function listProfiles() {
  const { active, profiles } = loadProfiles();
  return Object.entries(profiles).map(([name, entry]) => ({
    name,
    label: entry.label || '',
    token: entry.token || '',
    active: name === active,
  }));
}

export function useProfile(name) {
  const { active, profiles } = loadProfiles();
  if (!profiles[name]) return false;
  if (active && active !== name) {
    // The folder belongs to the bot that is leaving: keep its files.
    saveWorkspace(active);
  }
  saveProfiles({ active: name, profiles });
  // The state and the snapshot of the bot that is now active.
  setCurrentProfile(name);
  if (active !== name) {
    // And the files of the bot that is arriving take their place.
    restoreWorkspace(name);
  }
  return true;
}

// Stores a token under a profile name and makes it the active one.
export function saveProfileToken(name, token, label = '') {
  const { active, profiles } = loadProfiles();
  const key = name || DEFAULT_PROFILE;
  profiles[key] = { token, label: label || profiles[key]?.label || '' };
  if (!active) {
    // The first bot takes over the folder as it is right now.
    saveWorkspace(key);
    saveProfiles({ active: key, profiles });
    setCurrentProfile(key);
    return key;
  }
  // Another bot joins the folder: it is linked but not switched to, so the
  // folder keeps the files of the bot that is active.
  saveProfiles({ active, profiles });
  return key;
}

export function removeProfile(name) {
  const { active, profiles } = loadProfiles();
  if (!profiles[name]) return false;
  delete profiles[name];
  const nextActive = active === name ? Object.keys(profiles)[0] || null : active;
  saveProfiles({ active: nextActive, profiles });
  setCurrentProfile(nextActive);
  if (active === name) {
    // The bot is gone: its files leave the folder with it.
    restoreWorkspace(nextActive);
  }
  return true;
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

// Shared tail of both login paths: check the candidate, save it if the server
// takes it (or cannot be reached), and say what happened.
export async function loginWithToken(token, profile = '') {
  if (!isValidFormat(token)) {
    console.error('  That does not look like an access token — expected "app<id>:<secret>".');
    return null;
  }

  const check = await verifyToken(token);
  const target = profile || activeProfile() || DEFAULT_PROFILE;
  if (check.ok) {
    saveProfileToken(target, token);
    console.log(`  Linked to ${maskToken(token)}.`);
    log('info', 'login', 'Project linked to a bot.', { token: maskToken(token) });
    return token;
  }
  if (check.network) {
    saveProfileToken(target, token);
    console.log('  The server is unreachable, so the token was saved without verification.');
    console.log('  The next online command will confirm it.');
    log('warn', 'login', 'Token saved but not verified (network unreachable).', { token: maskToken(token) });
    return token;
  }
  console.error('  The server rejected that token.');
  return null;
}

// Loops until a working token is saved, the terminal closes, or the user is
// done. `preset` short-circuits the prompt (a token handed to "login" on the
// command line); the TTY check only applies when something has to be asked.
export async function loginInteractive(prompt, preset, profile = '') {
  if (preset !== undefined) return loginWithToken(String(preset).trim(), profile);

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

    const linked = await loginWithToken(token, profile);
    if (linked) return linked;
  }
}

export function unlinkBot() {
  const { active, profiles } = loadProfiles();
  if (active && profiles[active]) {
    removeProfile(active);
    ensureStateDir();
    return true;
  }
  if (loadCredentials() == null) return false;
  deleteCredentials();
  ensureStateDir();
  return true;
}
