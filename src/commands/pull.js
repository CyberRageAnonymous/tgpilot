import fs from 'fs';
import { createHash } from 'crypto';
import { parseArgs } from '../args.js';
import { info } from '../output.js';
import { c } from '../colors.js';
import { withToken } from '../project/credentials.js';
import { syncCapabilities } from '../project/layout.js';
import { getFiles } from '../api/endpoints.js';
import { replaceSnapshot, moduleToPath, listSnapshotPaths } from '../project/snapshot.js';
import { loadState, saveState } from '../project/state.js';
import { readDisk, writeDisk, unlinkDisk, existsDisk, displayPath, moduleToDisk } from '../project/workdir.js';
import { saveStaticSnapshot, loadStaticSnapshot } from '../project/static.js';
import { loadProjectConfig, configFileName } from '../project/config.js';
import { computeDiff } from '../diff.js';
import { confirm, closePrompts } from '../prompts.js';
import { createSpinner } from '../spinner.js';
import { log } from '../logs.js';

export async function registerPull(argv) {
  const args = parseArgs(argv, { flags: ['force'] });
  await syncCapabilities();

  await withToken(async (token) => {
    const spinner = createSpinner('Pulling from the cloud…');
    spinner.start();
    let response;
    try {
      response = await getFiles(token);
      spinner.stop();
    } catch (err) {
      spinner.stop();
      throw err;
    }

    const canonical = response.canonical_modules || {};
    const moduleNames = Object.keys(canonical);
    const serverPaths = new Set(moduleNames.map(moduleToPath));

    // Snapshot entries the server no longer holds and that still exist on
    // disk are orphans: candidates for deletion, computed before the snapshot
    // gets pruned.
    const orphans = listSnapshotPaths().filter((p) => !serverPaths.has(p) && existsDisk(p));

    if ('static' in response) saveStaticSnapshot(response.static);

    if (moduleNames.length === 0 && orphans.length === 0) {
      info('No files in the cloud.');
      replaceSnapshot(canonical);
      if (response.revision != null) {
        const state = loadState();
        state.last_known_revision = response.revision;
        saveState(state);
      }
      noteUnmanagedStatic(response.static);
      return;
    }

    const initTemplates = loadState().init_templates;
    let saved = 0;

    for (const moduleName of moduleNames) {
      const moduleFile = moduleToPath(moduleName);
      const shown = displayPath(moduleFile);
      const remoteContent = canonical[moduleName];

      if (existsDisk(moduleFile)) {
        const localContent = readDisk(moduleFile);
        if (localContent === remoteContent) {
          info(`  ${c.dim(shown)}  settled`);
          continue;
        }
        if (!args.flags.force && !isUntouchedScaffold(moduleFile, initTemplates)) {
          const patch = computeDiff(localContent, remoteContent, shown);
          for (const line of patch.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) console.log(c.green(line));
            else if (line.startsWith('-') && !line.startsWith('---')) console.log(c.red(line));
            else if (line.startsWith('@@')) console.log(c.cyan(line));
            else console.log(line);
          }
          const overwrite = await confirm(`Overwrite ${shown}?`);
          if (!overwrite) {
            info(`  ${c.dim(`⊘ ${shown} kept as is`)}`);
            continue;
          }
        }
      }

      writeDisk(moduleFile, remoteContent);
      info(`  ${c.green(`saved → ${shown}`)}`);
      saved++;
    }

    let removed = 0;
    for (const moduleFile of orphans) {
      const shown = displayPath(moduleFile);
      if (!args.flags.force) {
        console.log(`  ${c.red(`delete → ${shown}`)} ${c.dim('(gone in the cloud)')}`);
        const ok = await confirm(`Delete ${shown}?`);
        if (!ok) {
          info(`  ${c.dim(`⊘ ${shown} kept`)}`);
          continue;
        }
      }
      unlinkDisk(moduleFile);
      info(`  ${c.green(`deleted → ${shown}`)}`);
      removed++;
    }

    replaceSnapshot(canonical);

    if (response.revision != null) {
      const state = loadState();
      state.last_known_revision = response.revision;
      saveState(state);
    }

    closePrompts();

    log('info', 'pull', 'Pull finished.', {
      saved,
      removed,
      revision: response.revision ?? null,
    });
    info(`\nDone. ${saved} file${saved === 1 ? '' : 's'} pulled${removed ? `, ${removed} deleted` : ''}.`);
    noteUnmanagedStatic(response.static);
  });
}

// A file that still matches what init wrote can be replaced without asking:
// nobody has invested work into it.
function isUntouchedScaffold(moduleFile, initTemplates) {
  const expected = initTemplates?.[displayPath(moduleFile)];
  if (!expected) return false;
  const actual = 'sha256:' + createHash('sha256').update(fs.readFileSync(moduleToDisk(moduleFile))).digest('hex');
  return actual === expected;
}

function noteUnmanagedStatic(remoteStatic) {
  if (!remoteStatic) return;
  let managed = null;
  try {
    managed = loadProjectConfig({ tolerant: true }).static;
  } catch {
    return;
  }
  if (managed) return;
  console.log('');
  const lines = [
    `The bot hosts Mini App files${remoteStatic?.url ? ` at ${remoteStatic.url}` : ''}, which this project does not manage.`,
    `Add a "static" block to ${configFileName()} to take them over, or set "static": false to remove them.`,
  ];
  for (const line of lines) console.log('  ' + line);
}
