import fs from 'fs';
import { loadCachedCapabilities, saveCachedCapabilities } from './state.js';
import { fetchCapabilities } from '../api/endpoints.js';
import { warn } from '../output.js';
import { stripControl } from '../api/client.js';
import { readPackageVersion } from '../meta.js';

// A serverless project has one module root folder; module names on the wire
// are file paths under it, extension free. A descriptor fetched from the
// platform can rename the shape; the baseline below is the layout this tool
// is written for and stays in effect until a valid descriptor is cached.

export const SUPPORTED_SCHEMA_VERSION = 1;
export const MODULE_ROOT = 'tgcloud';

const BASELINE = {
  rootFiles: [
    { name: 'schema.js', singleton: true },
  ],
  directories: [
    { name: 'lib', nested: true, synced: true, runnable: false },
    { name: 'handlers', nested: false, synced: true, runnable: true },
    { name: 'endpoints', nested: false, synced: true, runnable: true },
  ],
  // What `init` scaffolds, in module space, when no descriptor is cached.
  scaffold: [
    'schema.js',
    'lib/',
    'handlers/',
    'handlers/message.js',
  ],
};

export const ROOT_FILES = BASELINE.rootFiles.map((f) => f.name);

// Names are strict, so the descriptor can never steer a write outside the
// module root and onto something else.
const SAFE_SEGMENT = /^[a-z0-9_-]+$/i;
const SAFE_FILE = /^[a-z0-9_-]+(\.[a-z0-9]+)+$/i;
const FORBIDDEN = new Set(['.tgpilot', '.tgcloud', '.git', 'node_modules', '.', '..']);

const MAX_TEMPLATES = 100;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_SCAFFOLD = 200;
const MAX_PATH_SEGMENTS = 8;

export function sanitizeRelPath(p, { allowDir = false } = {}) {
  if (typeof p !== 'string' || !p) return null;
  if (p.includes('\\')) return null;
  if (p.startsWith('/')) return null;
  const isDir = p.endsWith('/');
  if (isDir && !allowDir) return null;
  const body = isDir ? p.slice(0, -1) : p;
  const segments = body.split('/');
  if (!segments.length || segments.length > MAX_PATH_SEGMENTS) return null;
  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k];
    if (!segment) return null;
    if (/[\x00-\x1f\x7f]/.test(segment)) return null;
    if (FORBIDDEN.has(segment.toLowerCase())) return null;
    const last = k === segments.length - 1;
    if (last && !isDir) {
      if (!SAFE_FILE.test(segment)) return null;
    } else if (!SAFE_SEGMENT.test(segment)) {
      return null;
    }
  }
  return isDir ? `${body}/` : body;
}

function sanitizeDirectory(d) {
  if (!d || typeof d.name !== 'string') return null;
  if (!SAFE_SEGMENT.test(d.name) || FORBIDDEN.has(d.name.toLowerCase())) return null;
  const dir = {
    name: d.name,
    nested: d.nested === true,
    synced: d.synced !== false,
    runnable: d.runnable === true,
  };
  if (Array.isArray(d.allowed_names)) {
    const names = d.allowed_names.filter((n) => typeof n === 'string' && SAFE_SEGMENT.test(n));
    if (names.length) dir.allowedNames = names;
  }
  return dir;
}

function sanitizeRootFile(f) {
  if (!f || typeof f.name !== 'string') return null;
  if (!SAFE_FILE.test(f.name) || FORBIDDEN.has(f.name.toLowerCase())) return null;
  return { name: f.name, singleton: f.singleton === true };
}

function sanitizeTemplates(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  let count = 0;
  for (const [key, content] of Object.entries(raw)) {
    if (count >= MAX_TEMPLATES) break;
    const clean = sanitizeRelPath(key, { allowDir: true });
    if (!clean) continue;
    if (typeof content !== 'string') continue;
    if (Buffer.byteLength(content, 'utf-8') > MAX_TEMPLATE_BYTES) continue;
    out[clean] = content;
    count++;
  }
  return out;
}

export function validateDescriptor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.project_schema_version !== 'number') return null;

  const directories = Array.isArray(raw.directories)
    ? raw.directories.map(sanitizeDirectory).filter(Boolean)
    : [];
  if (!directories.length) return null;

  const rootFiles = Array.isArray(raw.root_files)
    ? raw.root_files.map(sanitizeRootFile).filter(Boolean)
    : [];

  const scaffold = Array.isArray(raw.scaffold)
    ? raw.scaffold.slice(0, MAX_SCAFFOLD).map((e) => sanitizeRelPath(e, { allowDir: true })).filter(Boolean)
    : [];

  return {
    project_schema_version: raw.project_schema_version,
    directories,
    rootFiles,
    scaffold,
    templates: sanitizeTemplates(raw.templates),
  };
}

function synthesizeScaffold(rootFiles, directories) {
  return [
    ...rootFiles.map((f) => f.name),
    ...directories.map((d) => `${d.name}/`),
  ];
}

// Descriptor paths are module-space names; anything starting with a known
// module name goes under the module root, the rest lands at the project root.
function placeModulePath(p, moduleNames) {
  return moduleNames.has(p.split('/')[0]) ? `${MODULE_ROOT}/${p}` : p;
}

let effective = null;

function layout() {
  if (effective) return effective;
  const raw = loadCachedCapabilities();
  const valid = validateDescriptor(raw);
  const directories = valid ? valid.directories : BASELINE.directories;
  const rootFiles = valid && valid.rootFiles.length ? valid.rootFiles : BASELINE.rootFiles;
  const moduleNames = new Set([
    ...rootFiles.map((f) => f.name),
    ...directories.map((d) => d.name),
  ]);
  effective = {
    nestedDirs: new Set(directories.filter((d) => d.nested).map((d) => d.name)),
    syncedDirs: new Set(directories.filter((d) => d.synced).map((d) => d.name)),
    runnableDirs: new Set(directories.filter((d) => d.runnable).map((d) => d.name)),
    rootFiles,
    moduleNames,
    // Templates stay module-space ("handlers/" or "schema.js"): commands look
    // them up after stripping the module-root prefix themselves.
    templates: valid ? valid.templates : {},
    scaffold: (valid
      ? (valid.scaffold.length ? valid.scaffold : synthesizeScaffold(rootFiles, directories))
      : BASELINE.scaffold
    ).map((e) => placeModulePath(e, moduleNames)),
    directories,
  };
  return effective;
}

export function resetLayout() {
  effective = null;
}

// Inverse of placeModulePath: drop the module-root prefix when present.
export function unplaceModulePath(p) {
  const prefix = `${MODULE_ROOT}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

export function moduleDirs() {
  return layout().directories.map((d) => d.name);
}

export function syncedDirs() {
  return layout().syncedDirs;
}

export function nestableDirs() {
  return layout().nestedDirs;
}

export function runnableDirs() {
  return layout().runnableDirs;
}

export function rootFileEntries() {
  return layout().rootFiles;
}

export function directoryFor(name) {
  return layout().directories.find((d) => d.name === name) || null;
}

export function templates() {
  return layout().templates;
}

export function scaffoldEntries() {
  return layout().scaffold;
}

export function findDisallowedModules(files) {
  const byDir = new Map(
    layout().directories.filter((d) => d.allowedNames).map((d) => [d.name, d.allowedNames])
  );
  if (byDir.size === 0) return [];
  const out = [];
  for (const file of files) {
    const parts = file.split(/[\\/]/);
    if (parts.length < 2) continue;
    const allowed = byDir.get(parts[0]);
    if (!allowed) continue;
    const name = parts[parts.length - 1].replace(/\.js$/, '');
    if (!allowed.includes(name)) out.push({ file, dir: parts[0], name, allowed });
  }
  return out;
}

// Refresh the layout descriptor from the platform. Quietly keeps the cache and
// the baseline when the endpoint is missing, offline or answers nonsense.
export async function syncCapabilities() {
  let raw;
  try {
    raw = await fetchCapabilities();
  } catch {
    return;
  }
  const valid = validateDescriptor(raw);
  if (!valid) return;

  if (valid.project_schema_version > SUPPORTED_SCHEMA_VERSION) {
    warn(
      `This project layout is newer than this tgpilot understands (schema v${valid.project_schema_version}` +
      ` > v${SUPPORTED_SCHEMA_VERSION}); newer directories may be ignored.` +
      '  Upgrade: npm i -g tgpilot@latest'
    );
  }
  if (raw.min_cli_version) {
    const ours = readPackageVersion();
    if (isOlder(ours, stripControl(raw.min_cli_version))) {
      warn(
        `This bot needs a tgpilot of at least ${stripControl(raw.min_cli_version)} (you have ${ours}).` +
        '  Upgrade: npm i -g tgpilot@latest'
      );
    }
  }

  saveCachedCapabilities(valid);
  resetLayout();
}

function isOlder(a, b) {
  const pa = String(a ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const x = pa[k] || 0;
    const y = pb[k] || 0;
    if (x !== y) return x < y;
  }
  return false;
}
