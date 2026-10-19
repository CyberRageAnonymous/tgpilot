import { parseArgs } from '../args.js';
import { info } from '../output.js';
import { c } from '../colors.js';
import { localDiff } from '../project/diff.js';
import { snapshotExists, moduleToPath } from '../project/snapshot.js';
import { displayPath, toModulePath } from '../project/workdir.js';
import { computeDiff } from '../diff.js';

// Like status, but prints the actual line changes per module. Offline too.

export async function registerDiff(argv) {
  const args = parseArgs(argv, {});
  const wanted = args.positional.length
    ? new Set(args.positional.map((t) => {
        const p = toModulePath(t);
        const withExt = p.endsWith('.js') ? p : `${p}.js`;
        return withExt;
      }))
    : null;

  if (!snapshotExists()) {
    info('No local snapshot yet, so there is nothing to diff against. Link a bot and run "tgpilot fetch".');
    return 0;
  }

  const diff = localDiff();
  const sections = [
    { title: 'New, not deployed yet:', bucket: diff.newLocal, paint: c.green, oldSide: '', newSide: 'local' },
    { title: 'Changed since last sync:', bucket: diff.modified, paint: c.yellow, oldSide: 'snapshot', newSide: 'local' },
    { title: 'Gone locally, still deployed:', bucket: diff.remoteOnly, paint: c.red, oldSide: 'snapshot', newSide: '' },
  ];

  let printed = 0;
  for (const section of sections) {
    for (const entry of section.bucket) {
      const modulePath = moduleToPath(entry.path);
      if (wanted && !wanted.has(modulePath)) continue;
      if (printed === 0) console.log('');
      printed++;

      const oldText = section.oldSide === 'snapshot' ? entry.snapshotContent : '';
      const newText = section.newSide === 'local' ? entry.localContent : '';
      console.log(section.paint(`${section.title} ${displayPath(entry.path)}`));
      const patch = computeDiff(oldText, newText, displayPath(entry.path));
      for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) console.log(c.green(line));
        else if (line.startsWith('-') && !line.startsWith('---')) console.log(c.red(line));
        else if (line.startsWith('@@')) console.log(c.cyan(line));
        else console.log(line);
      }
      console.log('');
    }
  }

  if (printed === 0) {
    info(wanted ? 'No changes for the files you named.' : 'Nothing has changed since the last sync.');
  }
  return 0;
}
