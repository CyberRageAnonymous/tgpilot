import { parseArgs } from '../args.js';
import { info, success } from '../output.js';
import { askHidden } from '../prompts.js';
import { loginWithToken, maskToken, listProfiles, useProfile, removeProfile, activeProfile } from '../project/credentials.js';
import { getFiles } from '../api/endpoints.js';
import { replaceSnapshot } from '../project/snapshot.js';
import { saveStaticSnapshot } from '../project/static.js';
import { loadState, saveState } from '../project/state.js';
import { log } from '../logs.js';
import { withToken } from '../project/credentials.js';

// login is the one command that asks for a token; logout forgets it. The
// profile commands manage the bots a folder is linked to.

export async function registerAuth(command, argv) {
  const parsed = parseArgs(argv, { values: ['profile'] });

  if (command === 'logout') {
    const name = parsed.values.profile || activeProfile();
    if (!name || !removeProfile(name)) {
      info('Nothing to forget — no saved token here.');
      return 0;
    }
    log('info', 'logout', 'Token removed.', { profile: name });
    info(`Token for profile "${name}" removed. Run "tgpilot login" to link a bot again.`);
    return 0;
  }

  // A pasted token bypasses the hidden prompt — handy in scripts and for
  // anyone typing it straight onto the command line.
  const pasted = parsed.positional[0];
  const token = pasted !== undefined
    ? await loginWithToken(String(pasted).trim(), parsed.values.profile)
    : await loginInteractive((question) => askHidden(question), parsed.values.profile);
  if (!token) return 1;

  // Bring the bot's current state down right away, so the first push is
  // conflict-checked instead of blind.
  try {
    await withToken(async (t) => {
      const remote = await getFiles(t);
      replaceSnapshot(remote.canonical_modules || {});
      if ('static' in remote) saveStaticSnapshot(remote.static);
      if (remote.revision != null) {
        const state = loadState();
        state.last_known_revision = remote.revision;
        saveState(state);
      }
      const count = Object.keys(remote.canonical_modules || {}).length;
      info(
        `Synced the bot's current state: ${count} module${count === 1 ? '' : 's'}` +
        (remote.revision != null ? `, revision ${remote.revision}` : '') +
        (count > 0 ? '. Compare with "tgpilot status".' : '.')
      );
    });
  } catch {
    info('Could not fetch the current state. It will sync on the next command.');
  }
  return 0;
}

// tgpilot profiles — the bots this folder is linked to.
export async function registerProfiles(argv) {
  const parsed = parseArgs(argv, { flags: ['use'], values: ['profile'] });
  const profiles = listProfiles();

  if (parsed.flags.use) {
    const name = parsed.values.profile || parsed.positional[0];
    if (!name) {
      info('Which profile? "tgpilot profiles --use <name>"');
      return 1;
    }
    if (!useProfile(name)) {
      info(`There is no profile called "${name}".`);
      return 1;
    }
    success(`Now talking to the profile "${name}".`);
    return 0;
  }

  if (!profiles.length) {
    info('No profiles yet. Link one with "tgpilot login" or "tgpilot login --profile staging <token>".');
    return 0;
  }

  info('\n  Profiles:\n');
  for (const profile of profiles) {
    const mark = profile.active ? '*' : ' ';
    const label = profile.label ? ` — ${profile.label}` : '';
    info(`  ${mark} ${profile.name}${label}`);
    info(`      ${profile.token ? maskToken(profile.token) : 'no token'}   (${profile.active ? 'active' : 'use with --use'})`);
  }
  info('');
  info('  Switch with: tgpilot profiles --use <name>');
  return 0;
}
