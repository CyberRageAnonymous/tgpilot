import fs from 'fs';
import path from 'path';
import { MODULE_ROOT } from './layout.js';
import { ensureStateDir } from './state.js';

// Backups are safety nets: a copy of the code as it is right now, so a
// change that breaks the bot can be undone with one click. They live inside
// .tgpilot/ and are never deployed.

// The backups live next to the other local state and are never deployed.
const BACKUP_DIR = path.join('.tgpilot', 'backups');

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function safeName(label) {
  const cleaned = String(label || '')
    .trim()
    .replace(/[^\w\s.-]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return cleaned || 'backup';
}

// Everything that is part of the project: the modules, the root files and
// the Mini App build.
function collectSources(root) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(path.join(rel, name));
      }
      return;
    }
    if (stat.isFile()) files.push(rel);
  };

  if (fs.existsSync(path.join(root, MODULE_ROOT))) walk(MODULE_ROOT);
  for (const name of fs.readdirSync(root).sort()) {
    if (name === '.tgpilot' || name === 'node_modules' || name.startsWith('.')) continue;
    const rel = name;
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile() && /\.(js|json|jsonc|md|txt|html|css|js)$/.test(name)) files.push(rel);
    else if (stat.isDirectory() && (name === 'dist' || name === 'public')) walk(rel);
  }
  return [...new Set(files)];
}

export function listBackups(root = process.cwd()) {
  const dir = path.join(root, BACKUP_DIR);
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir).sort().reverse()) {
    const full = path.join(dir, name);
    const manifestPath = path.join(full, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      entries.push({ id: name, ...manifest });
    } catch {
      /* a broken backup is simply not listed */
    }
  }
  return entries;
}

// Takes a copy of the project. Returns the manifest of what was saved.
export function createBackup(root = process.cwd(), { label = '', note = '' } = {}) {
  const files = collectSources(root);
  const id = `${stamp()}-${safeName(label)}`;
  const dir = path.join(root, BACKUP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  let bytes = 0;
  for (const rel of files) {
    const from = path.join(root, rel);
    const to = path.join(dir, 'files', rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      bytes += fs.statSync(to).size;
    } catch {
      /* a file that vanished mid-copy is simply left out */
    }
  }

  const manifest = {
    id,
    label: label ? String(label).trim() : '',
    note: note ? String(note).trim() : '',
    createdAt: new Date().toISOString(),
    files: files.length,
    bytes,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  ensureStateDir();
  return manifest;
}

// Puts a backup back on disk. The state right now is saved as a backup
// first, so a restore can never destroy work.
export function restoreBackup(root = process.cwd(), id, { keepCurrent = true } = {}) {
  const dir = path.join(root, BACKUP_DIR, id);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const err = new Error(`There is no backup called "${id}".`);
    err.kind = 'missing';
    throw err;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const safety = keepCurrent ? createBackup(root, { label: 'before restore' }) : null;

  const filesRoot = path.join(dir, 'files');
  const restored = [];
  const walk = (rel) => {
    const abs = path.join(filesRoot, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const child = path.join(rel, name);
      const childAbs = path.join(filesRoot, child);
      if (fs.statSync(childAbs).isDirectory()) walk(child);
      else {
        const target = path.join(root, child);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(childAbs, target);
        restored.push(child);
      }
    }
  };
  if (fs.existsSync(filesRoot)) walk('.');

  return { manifest, restored, safety };
}

export function removeBackup(root = process.cwd(), id) {
  const dir = path.join(root, BACKUP_DIR, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
