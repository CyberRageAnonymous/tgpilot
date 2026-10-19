import { parseArgs } from '../args.js';
import { info } from '../output.js';
import { withToken } from '../project/credentials.js';
import { syncCapabilities } from '../project/layout.js';
import { getFiles } from '../api/endpoints.js';
import { replaceSnapshot } from '../project/snapshot.js';
import { saveStaticSnapshot } from '../project/static.js';
import { loadState, saveState } from '../project/state.js';
import { log } from '../logs.js';

// Updates only the snapshot (the baseline status/diff compare against);
// the working files stay untouched.

export async function registerFetch(argv) {
  parseArgs(argv, {});

  const { count, revision, staticBlock } = await withToken(async (token) => {
    const response = await getFiles(token);
    const canonical = response.canonical_modules || {};
    replaceSnapshot(canonical);
    if ('static' in response) saveStaticSnapshot(response.static);
    if (response.revision != null) {
      const state = loadState();
      state.last_known_revision = response.revision;
      saveState(state);
    }
    return {
      count: Object.keys(canonical).length,
      revision: response.revision ?? null,
      staticBlock: 'static' in response ? response.static : null,
    };
  });

  log('info', 'fetch', 'Snapshot refreshed.', { count, revision });

  const rightNow = revision != null ? ` (revision ${revision})` : '';
  info(`Snapshot updated — ${count} module${count === 1 ? '' : 's'}${rightNow}.`);
  if (staticBlock) {
    const files = staticBlock && typeof staticBlock === 'object' ? Object.keys(staticBlock.manifest || {}).length : 0;
    info(files ? `Static snapshot updated — ${files} file${files === 1 ? '' : 's'} hosted.` : 'Static state updated.');
  }
  if (count === 0) info('The bot has no modules. Push yours: "tgpilot push".');
  return 0;
}
