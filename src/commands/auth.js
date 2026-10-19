import { parseArgs } from '../args.js';
import { info } from '../output.js';
import { askHidden } from '../prompts.js';
import { loginInteractive, loginWithToken, maskToken, unlinkBot, withToken } from '../project/credentials.js';
import { getFiles } from '../api/endpoints.js';
import { replaceSnapshot } from '../project/snapshot.js';
import { saveStaticSnapshot } from '../project/static.js';
import { loadState, saveState, loadCredentials } from '../project/state.js';
import { log } from '../logs.js';

// login is the one command that asks for a token; logout forgets it.

export async function registerAuth(command, argv) {
  const parsed = parseArgs(argv, {});

  if (command === 'logout') {
    const saved = loadCredentials();
    if (!unlinkBot()) {
      info('Nothing to forget — no saved token here.');
      return 0;
    }
    log('info', 'logout', 'Token removed.', { token: maskToken(saved?.token) });
    info(`Token for ${maskToken(saved?.token)} removed. Run "tgpilot login" to link a bot again.`);
    return 0;
  }

  // A pasted token bypasses the hidden prompt — handy in scripts and for
  // anyone typing it straight onto the command line.
  const pasted = parsed.positional[0];
  const token = pasted !== undefined
    ? await loginWithToken(String(pasted).trim())
    : await loginInteractive((question) => askHidden(question));
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
