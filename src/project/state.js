import fs from 'fs';
import path from 'path';

// Machine-local state lives in `.tgpilot/` and is git-ignored: the saved bot
// token, the cached layout descriptor, the last known revision and the hash of
// every scaffolded file. Readers treat missing or broken files as blank state.

export const STATE_DIR = '.tgpilot';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CAPABILITIES_FILE = path.join(STATE_DIR, 'capabilities.json');
const CREDENTIALS_FILE = path.join(STATE_DIR, 'credentials');

export function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function emptyState() {
  return {
    last_known_revision: null,
    init_templates: {},
  };
}

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

// Write through a temp sibling so a crash mid-write can never leave a
// truncated file behind.
function atomicWrite(file, content) {
  ensureStateDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

export function saveState(state) {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function saveInitTemplateHash(file, digest) {
  const state = loadState();
  state.init_templates[file] = digest;
  saveState(state);
}

export function loadCachedCapabilities() {
  if (!fs.existsSync(CAPABILITIES_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CAPABILITIES_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveCachedCapabilities(descriptor) {
  atomicWrite(CAPABILITIES_FILE, JSON.stringify(descriptor, null, 2) + '\n');
}

export function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    return parsed && typeof parsed.token === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCredentials(token) {
  ensureStateDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  // mode only applies on creation, hence the chmod afterwards.
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* Windows has no bits */ }
}

export function deleteCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE);
}

