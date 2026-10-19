import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { toPosix } from './snapshot.js';
import { sameConfig, normalizeConfig } from './config.js';

// Static hosting of the Mini App's build folder. A version is a manifest of
// `{ path: { hash, size } }` plus the serving config; the local snapshot keeps
// the last `static` block the server returned, hashes included.

const SNAPSHOT_FILE = path.join('.tgpilot', 'static.json');

export function hashStaticFile(absPath) {
  return createHash('md5').update(fs.readFileSync(absPath)).digest('hex');
}

export function scanStatic(source) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return null;
  const manifest = {};
  const abs = {};
  const skipped = [];
  const nonNfc = [];

  const walk = (rel) => {
    const dir = rel ? path.join(source, rel) : source;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const posix = toPosix(childRel);
      if (entry.name.startsWith('.')) { skipped.push(posix); continue; }
      const full = path.join(dir, entry.name);
      let st;
      try { st = fs.statSync(full); } catch { skipped.push(posix); continue; }
      if (st.isDirectory()) { walk(childRel); continue; }
      if (!st.isFile()) { skipped.push(posix); continue; }
      manifest[posix] = { hash: hashStaticFile(full), size: st.size };
      abs[posix] = full;
      if (posix.normalize('NFC') !== posix) nonNfc.push(posix);
    }
  };
  walk('');

  return { manifest, abs, skipped, nonNfc };
}

export function loadStaticSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && parsed.hash ? parsed : null;
  } catch {
    return null;
  }
}

export function saveStaticSnapshot(block) {
  if (!block) {
    fs.rmSync(SNAPSHOT_FILE, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(block, null, 2) + '\n');
}

export function staticDiff(local, config, snapshot) {
  const remote = snapshot?.manifest || {};
  const added = [];
  const modified = [];
  const deleted = [];
  let unchanged = 0;

  for (const [p, entry] of Object.entries(local.manifest)) {
    if (!(p in remote)) added.push(p);
    else if (remote[p].hash !== entry.hash) modified.push(p);
    else unchanged++;
  }
  for (const p of Object.keys(remote)) {
    if (!(p in local.manifest)) deleted.push(p);
  }

  const sort = (list) => list.sort((x, y) => x.localeCompare(y));
  const configChanged = !snapshot || !sameConfig(normalizeConfig(config), normalizeConfig(snapshot.config));
  const changed = added.length + modified.length + deleted.length > 0 || configChanged;
  return { added: sort(added), modified: sort(modified), deleted: sort(deleted), unchanged, configChanged, changed };
}

export function unmanagedStaticNotice(snapshot, configFile) {
  return [
    `Mini App files active${snapshot?.url ? ` at ${snapshot.url}` : ''}`,
    'The bot hosts a build that this project does not manage.',
    `Add a "static" block to ${configFile} to take it over, or set "static": false to remove it.`,
  ];
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
