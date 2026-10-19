import { scanFiles } from './scanner.js';
import { readDisk } from './workdir.js';
import { listSnapshotPaths, readSnapshotFile } from './snapshot.js';

// What the working directory says against the snapshot. Returns one bucket per
// possible life of a file; every entry carries its module path.

export function localDiff() {
  const localFiles = scanFiles();
  const snapshotFiles = listSnapshotPaths();

  const localSet = new Set(localFiles);
  const snapshotSet = new Set(snapshotFiles);
  const allPaths = new Set([...localFiles, ...snapshotFiles]);

  const modified = [];
  const newLocal = [];
  const remoteOnly = [];
  const matched = [];

  for (const modulePath of allPaths) {
    const hasLocal = localSet.has(modulePath);
    const hasSnapshot = snapshotSet.has(modulePath);

    if (hasLocal && !hasSnapshot) {
      newLocal.push({ path: modulePath, localContent: readDisk(modulePath) });
    } else if (!hasLocal && hasSnapshot) {
      remoteOnly.push({ path: modulePath, snapshotContent: readSnapshotFile(modulePath) ?? '' });
    } else {
      const localContent = readDisk(modulePath);
      const snapshotContent = readSnapshotFile(modulePath) ?? '';
      if (localContent === snapshotContent) {
        matched.push({ path: modulePath, localContent });
      } else {
        modified.push({ path: modulePath, localContent, snapshotContent });
      }
    }
  }

  return { modified, newLocal, remoteOnly, matched };
}
