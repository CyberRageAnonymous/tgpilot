import fs from 'fs';
import path from 'path';

// Machine-local state lives in `.tgpilot/` and is git-ignored: the saved bot
// token, the cached layout descriptor, the last known revision and the hash of
// every scaffolded file. Readers treat missing or broken files as blank state.

export const STATE_DIR = '.tgpilot';
const PROFILES_DIR = path.join(STATE_DIR, 'profiles');
const LEGACY_STATE_FILE = path.join(STATE_DIR, 'state.json');
const LEGACY_CAPABILITIES_FILE = path.join(STATE_DIR, 'capabilities.json');
const CREDENTIALS_FILE = path.join(STATE_DIR, 'credentials');

// Every bot in a folder has its own state: the revision it is at, the
// snapshot of its code, the migrations it carries. Switching bots therefore
// shows that bot's world, not the previous one's.
export function profileStateDir(profile) {
  const name = String(profile || 'default').replace(/[^\w.-]+/g, '_') || 'default';
  return path.join(PROFILES_DIR, name);
}

let activeProfileName = null;

// The profile whose state is in use right now.
export function currentProfile() {
  if (activeProfileName) return activeProfileName;
  const profiles = loadProfiles();
  activeProfileName = profiles.active || 'default';
  return activeProfileName;
}

// Called when the studio or the CLI switches bots.
export function setCurrentProfile(name) {
  activeProfileName = name || 'default';
  return activeProfileName;
}

function stateFile() {
  return path.join(profileStateDir(currentProfile()), 'state.json');
}

function capabilitiesFile() {
  return path.join(profileStateDir(currentProfile()), 'capabilities.json');
}

// A project that was linked before profiles existed keeps its state: it
// belongs to the default bot.
function migrateLegacyState() {
  const dir = profileStateDir('default');
  try {
    if (fs.existsSync(LEGACY_STATE_FILE) && !fs.existsSync(path.join(dir, 'state.json'))) {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(LEGACY_STATE_FILE, path.join(dir, 'state.json'));
    }
    if (fs.existsSync(LEGACY_CAPABILITIES_FILE) && !fs.existsSync(path.join(dir, 'capabilities.json'))) {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(LEGACY_CAPABILITIES_FILE, path.join(dir, 'capabilities.json'));
    }
    const legacySnapshot = path.join(STATE_DIR, 'snapshot');
    const targetSnapshot = path.join(dir, 'snapshot');
    if (fs.existsSync(legacySnapshot) && !fs.existsSync(targetSnapshot)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(legacySnapshot, targetSnapshot);
    }
  } catch {
    /* a folder that cannot be reorganised still works, it just starts fresh */
  }
}

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
  migrateLegacyState();
  const file = stateFile();
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
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
  migrateLegacyState();
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
}

export function saveInitTemplateHash(file, digest) {
  const state = loadState();
  state.init_templates[file] = digest;
  saveState(state);
}

export function loadCachedCapabilities() {
  migrateLegacyState();
  const file = capabilitiesFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveCachedCapabilities(descriptor) {
  migrateLegacyState();
  const file = capabilitiesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(descriptor, null, 2) + '\n');
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

// --- profiles ----------------------------------------------------------------
// A project can be linked to more than one bot: a staging copy next to the
// production one, a second bot for experiments. The profiles live in their
// own file; the old single-token file stays the "default" profile.

const PROFILES_FILE = path.join(STATE_DIR, 'profiles.json');

export const DEFAULT_PROFILE = 'default';

function emptyProfiles() {
  return { active: DEFAULT_PROFILE, profiles: {} };
}

export function loadProfiles() {
  let saved = null;
  if (fs.existsSync(PROFILES_FILE)) {
    try {
      saved = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
    } catch {
      saved = null;
    }
  }
  const profiles = saved && typeof saved.profiles === 'object' && saved.profiles ? saved.profiles : {};
  const legacy = loadCredentials();
  if (legacy?.token && !profiles[DEFAULT_PROFILE]) {
    profiles[DEFAULT_PROFILE] = { token: legacy.token, label: '' };
  }
  const active = saved?.active && profiles[saved.active] ? saved.active : profiles[DEFAULT_PROFILE] ? DEFAULT_PROFILE : Object.keys(profiles)[0] || null;
  return { active, profiles };
}

export function saveProfiles(data) {
  ensureStateDir();
  const payload = {
    active: data.active || null,
    profiles: data.profiles || {},
  };
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(PROFILES_FILE, 0o600); } catch { /* Windows has no bits */ }
  // Keep the single-token file in sync with the default profile, so older
  // tools and scripts still find a token where they expect it.
  if (payload.profiles[DEFAULT_PROFILE]?.token) {
    saveCredentials(payload.profiles[DEFAULT_PROFILE].token);
  } else if (!payload.profiles[DEFAULT_PROFILE]) {
    deleteCredentials();
  }
}

export function profileNames() {
  return loadProfiles();
}
