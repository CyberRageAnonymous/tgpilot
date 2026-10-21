import { moduleToPath, replaceSnapshot, listSnapshotPaths } from './snapshot.js';
import { existsDisk, readDisk, writeDisk, unlinkDisk, displayPath } from './workdir.js';
import { createBackup } from './backup.js';

// A bot can be changed from a phone, from another machine or from the cloud
// itself. This is the reconciliation: what the cloud holds is the truth, and
// the folder follows it — new files included.
//
// Local files the cloud never knew (a helper, a note, work in progress) are
// never touched.

export function previewSync(canonical) {
  const modules = canonical || {};
  const added = [];
  const updated = [];
  const unchanged = [];
  const removed = [];

  for (const [name, content] of Object.entries(modules)) {
    const rel = moduleToPath(name);
    if (!existsDisk(rel)) added.push(rel);
    else if (readDisk(rel) !== content) updated.push(rel);
    else unchanged.push(rel);
  }

  // Files the cloud used to hold and no longer does: only those the snapshot
  // knows are candidates, never a local file that was never deployed.
  const known = new Set(Object.keys(modules).map(moduleToPath));
  for (const rel of listSnapshotPaths()) {
    if (!known.has(rel) && existsDisk(rel)) removed.push(rel);
  }

  return {
    added: added.map(displayPath),
    updated: updated.map(displayPath),
    unchanged: unchanged.map(displayPath),
    removed: removed.map(displayPath),
    counts: { added: added.length, updated: updated.length, unchanged: unchanged.length, removed: removed.length },
  };
}

// Writes the cloud's state into the folder. A backup is taken first, so a
// sync can always be undone.
export function applySync(canonical, { backup = true, removeMissing = true } = {}) {
  const modules = canonical || {};
  const safety = backup ? createBackup(process.cwd(), { label: 'before sync' }) : null;
  const written = [];
  const deleted = [];

  for (const [name, content] of Object.entries(modules)) {
    const rel = moduleToPath(name);
    if (!existsDisk(rel) || readDisk(rel) !== content) {
      writeDisk(rel, content);
      written.push(displayPath(rel));
    }
  }

  if (removeMissing) {
    const known = new Set(Object.keys(modules).map(moduleToPath));
    for (const rel of listSnapshotPaths()) {
      if (!known.has(rel) && existsDisk(rel)) {
        unlinkDisk(rel);
        deleted.push(displayPath(rel));
      }
    }
  }

  replaceSnapshot(modules);
  return { written, deleted, safety };
}
