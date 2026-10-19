import { parseArgs } from '../args.js';
import { info, fatal, done } from '../output.js';
import { c } from '../colors.js';
import { snapshotExists, readSnapshotFile } from '../project/snapshot.js';
import { localDiff } from '../project/diff.js';
import { writeDisk, unlinkDisk, displayPath, toModulePath } from '../project/workdir.js';
import { confirm, closePrompts } from '../prompts.js';
import { log } from '../logs.js';

// Offline undo: rewrites and deletes come straight from the snapshot.

export async function registerReset(argv) {
  const args = parseArgs(argv, {});

  if (!snapshotExists()) {
    fatal('No local snapshot yet. Run "tgpilot pull" or "tgpilot fetch" first, or link a bot with "tgpilot login".');
  }

  const diff = localDiff();
  const changes = [
    ...diff.modified.map((f) => ({ ...f, kind: 'modified' })),
    ...diff.newLocal.map((f) => ({ ...f, kind: 'new' })),
    ...diff.remoteOnly.map((f) => ({ ...f, kind: 'deleted' })),
  ];

  const target = args.positional[0] ? toModulePath(args.positional[0]) : null;
  const filtered = target
    ? changes.filter((change) => change.path === target || change.path === `${target}.js`)
    : changes;

  if (!filtered.length) {
    info(target ? `${args.positional[0]}: nothing to reset.` : 'Working folder is clean. Nothing to reset.');
    return 0;
  }

  if (!target) {
    console.log(`Will reset ${filtered.length} file${filtered.length === 1 ? '' : 's'}:`);
    for (const change of filtered) {
      console.log('  ' + c.dim(`${labelFor(change.kind).padEnd(7)} →  `) + displayPath(change.path));
    }
    const ok = await confirm('Reset all local changes?');
    closePrompts();
    if (!ok) {
      info('Cancelled.');
      return 0;
    }
  }

  const touched = [];
  for (const change of filtered) {
    if (change.kind === 'modified' || change.kind === 'deleted') {
      const content = readSnapshotFile(change.path);
      if (content == null) fatal(`Snapshot is missing ${change.path} (unexpected).`);
      writeDisk(change.path, content);
      done(displayPath(change.path), 'restored');
    } else {
      unlinkDisk(change.path);
      done(displayPath(change.path), 'removed');
    }
    touched.push(displayPath(change.path));
  }

  log('info', 'reset', 'Local changes reset from the snapshot.', { files: touched });
  return 0;
}

function labelFor(kind) {
  if (kind === 'modified') return 'rewrite';
  if (kind === 'new') return 'remove';
  if (kind === 'deleted') return 'restore';
  return '';
}
