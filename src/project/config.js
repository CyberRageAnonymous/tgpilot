import fs from 'fs';
import { fatal } from '../output.js';

// Project config: `tgcloud.jsonc` (comments allowed) or `tgcloud.json`
// (strict JSON). One per project at the root. The interesting part is the
// `static` block for Mini App hosting; everything else is ignored here.

export const CONFIG_FILE = 'tgcloud.json';
export const CONFIG_FILE_JSONC = 'tgcloud.jsonc';

export function configFileName() {
  return fs.existsSync(CONFIG_FILE) && !fs.existsSync(CONFIG_FILE_JSONC) ? CONFIG_FILE : CONFIG_FILE_JSONC;
}

const SERVING_KEYS = ['spa', 'immutable', 'headers', 'redirects'];

export function loadProjectConfig({ tolerant = false } = {}) {
  const raise = (message) => {
    if (tolerant) return null;
    fatal(message);
  };
  const hasJson = fs.existsSync(CONFIG_FILE);
  const hasJsonc = fs.existsSync(CONFIG_FILE_JSONC);

  if (hasJson && hasJsonc) {
    return raise(`Both ${CONFIG_FILE} and ${CONFIG_FILE_JSONC} exist — keep one.`) ?? { static: null };
  }
  if (!hasJson && !hasJsonc) return { static: null };

  const file = hasJson ? CONFIG_FILE : CONFIG_FILE_JSONC;
  const text = fs.readFileSync(file, 'utf-8');

  let raw;
  try {
    raw = JSON.parse(hasJson ? text : stripJsonc(text));
  } catch (err) {
    let hint = '';
    if (hasJson) {
      try {
        JSON.parse(stripJsonc(text));
        hint = ` Comments need the .jsonc variant: rename the file to ${CONFIG_FILE_JSONC}.`;
      } catch { /* a real syntax error, keep the first message */ }
    }
    return raise(`${file}: ${err.message}.${hint}`) ?? { static: null };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raise(`${file}: must be a JSON object`) ?? { static: null };
  }

  try {
    return { static: parseStatic(raw.static) };
  } catch (err) {
    if (tolerant) return { static: null };
    throw err;
  }
}

// JSONC → JSON, keeping positions stable: comments become spaces, trailing
// commas are removed.
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (match, str, close) => (str ?? close));
}

// The accepted shapes: absent → null, `false` → removal request, a folder
// string → source only, or an object with `source` plus serving keys.
export function parseStatic(value) {
  if (value === undefined || value === null) return null;
  if (value === false) return { remove: true };
  if (typeof value === 'string') return { source: requireSource(value), config: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${configFileName()}: "static" must be a folder name, an object, or false.`);
  }
  const { source, build, ...config } = value;
  if (build !== undefined) {
    throw new Error(`${configFileName()}: "static.build" is not supported yet — run your build, then push.`);
  }
  return { source: requireSource(source), config };
}

function requireSource(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error(`${configFileName()}: "static" needs a "source" folder (e.g. "dist").`);
  }
  const s = source.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s || s.startsWith('/') || s.split('/').some((seg) => seg === '..' || seg === '.' || !seg)) {
    throw new Error(`${configFileName()}: "static.source" must be a folder inside the project (got "${source}").`);
  }
  return s;
}

// The server expects all four serving keys, each complete; unknown keys pass
// through untouched so the server can extend the schema without breaking us.
export function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {};
  const out = {
    spa: input.spa === true,
    immutable: Array.isArray(input.immutable) ? [...input.immutable] : [],
    headers: Array.isArray(input.headers) ? input.headers.map((h) => ({ ...h })) : [],
    redirects: Array.isArray(input.redirects)
      ? input.redirects.map((r) => ({ from: r?.from, to: r?.to, status: r?.status ?? 301 }))
      : [],
  };
  for (const key of Object.keys(input)) {
    if (!SERVING_KEYS.includes(key)) out[key] = input[key];
  }
  return out;
}

// Two configs describe the same bundle when their canonical forms match:
// `immutable` and the header `set` objects compare order-insensitively; rules
// keep their order.
export function sameConfig(a, b) {
  const canon = (config) => {
    const n = normalizeConfig(config);
    const sortedSet = (set) => Object.fromEntries(Object.keys(set || {}).sort().map((k) => [k, set[k]]));
    return JSON.stringify({
      ...n,
      immutable: [...n.immutable].sort(),
      headers: n.headers.map((h) => ({ path: h.path, set: sortedSet(h.set) })),
    });
  };
  return canon(a) === canon(b);
}
