import fs from 'fs';
import path from 'path';
import { ensureStateDir } from './state.js';

// The snapshot is a local mirror of what the platform last reported, used to
// compute what changed offline. Lives under `.tgpilot/snapshot/`.

const SNAPSHOT_DIR = path.join('.tgpilot', 'snapshot');

export function toPosix(p) {
  return String(p).split(/[\\/]/).join('/');
}

export function pathToModule(filePath) {
  const p = toPosix(filePath);
  return p.endsWith('.js') ? p.slice(0, -3) : p;
}

export function moduleToPath(moduleName) {
  const p = toPosix(moduleName);
  return p.endsWith('.js') ? p : `${p}.js`;
}

export function snapshotExists() {
  return fs.existsSync(SNAPSHOT_DIR);
}

export function readSnapshotFile(relPath) {
  const target = path.join(SNAPSHOT_DIR, relPath);
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target, 'utf-8');
}

export function writeSnapshotFile(relPath, content) {
  ensureStateDir();
  const target = path.join(SNAPSHOT_DIR, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function deleteSnapshotFile(relPath) {
  const target = path.join(SNAPSHOT_DIR, relPath);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

export function listSnapshotPaths() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  const out = [];
  const walk = (root, rel) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(root, entry.name), child);
      else if (entry.isFile()) out.push(toPosix(child));
    }
  };
  walk(SNAPSHOT_DIR, '');
  return out;
}

// Store every module of a canonical_modules map ({ name: content }).
export function applyCanonicalModules(canonicalModules) {
  if (!canonicalModules) return;
  for (const [moduleName, content] of Object.entries(canonicalModules)) {
    writeSnapshotFile(moduleToPath(moduleName), content);
  }
}

// Make the snapshot exactly canonical_modules: anything else is dropped.
export function replaceSnapshot(canonicalModules) {
  ensureStateDir();
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const existing = new Set(listSnapshotPaths());
  const fresh = new Set();

  for (const [moduleName, content] of Object.entries(canonicalModules || {})) {
    const modulePath = moduleToPath(moduleName);
    writeSnapshotFile(modulePath, content);
    fresh.add(modulePath);
  }

  for (const existingPath of existing) {
    if (!fresh.has(existingPath)) deleteSnapshotFile(existingPath);
  }
}
