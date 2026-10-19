import fs from 'fs';
import path from 'path';
import { MODULE_ROOT, rootFileEntries, moduleDirs } from './layout.js';
import { listSnapshotPaths } from './snapshot.js';
import { fatal } from '../output.js';

// A project root is the first directory walking up that contains the module
// root or the state dir — so every command works from any subfolder too.

export function isProjectRoot(dir) {
  return fs.existsSync(path.join(dir, MODULE_ROOT)) || fs.existsSync(path.join(dir, '.tgpilot'));
}

export function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  for (;;) {
    if (isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Layouts made before the module root existed kept modules at the project
// root. They are recognizable: those entries exist at the root, the module
// root is unpopulated, and there is something in the snapshot worth keeping.
export function findLegacyEntries(start = process.cwd()) {
  const stat = (p, kind) => {
    try { const s = fs.statSync(p); return s[kind](); } catch { return false; }
  };

  const names = [...rootFileEntries().map((f) => f.name), ...moduleDirs()];
  const populated = names.some((n) => fs.existsSync(path.join(start, MODULE_ROOT, n)));
  if (populated) return [];

  const files = names.filter((n) => path.extname(n) && n.includes('.') && stat(path.join(start, n), 'isFile'));
  const dirs = names
    .filter((n) => !n.includes('.') && stat(path.join(start, n), 'isDirectory'))
    .map((n) => `${n}/`);

  if (!files.length && !listSnapshotPaths().length) return [];
  return [...files, ...dirs];
}

// Old layouts are unusable as-is; the upgrade command is the way out.
export function requireCurrentLayout(start = process.cwd()) {
  const legacy = findLegacyEntries(start);
  if (!legacy.length) return;
  fatal(
    `This project uses the old layout (${legacy.join(', ')}) — before the tgcloud/ folder.\n` +
    '  Run "tgpilot upgrade" to move everything under tgcloud/.'
  );
}
