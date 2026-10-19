// The journal: one JSON-lines file per day under .tgpilot/logs/. Every
// meaningful action lands here — deploys, runs, migrations, webhook fixes,
// login/unlink — so history survives long after the terminal has scrolled by.

import fs from 'fs';
import path from 'path';
import { STATE_DIR } from './project/state.js';
import { plain } from './colors.js';

const LOG_DIR = path.join(STATE_DIR, 'logs');

export const LEVELS = {
  info: 0,
  warn: 1,
  error: 2,
};

function fileFor(date) {
  return path.join(LOG_DIR, `app-${date}.jsonl`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function safeRecord(level, scope, message, data) {
  return {
    t: new Date().toISOString(),
    level,
    scope,
    msg: plain(message),
    ...(data !== undefined && data !== null ? { data: stringifySafe(data) } : {}),
  };
}

// Values going into the journal are developer shapes (files, counts, hashes);
// anything that survives JSON round-trip is written as-is in compact form.
function stringifySafe(data) {
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return { unserializable: true };
  }
}

export function log(level, scope, message, data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify(safeRecord(level, scope, message, data));
    fs.appendFileSync(fileFor(today()), line + '\n');
  } catch {
    // The tool must keep working even when the journal is unhappy.
  }
}

// Newest first, with a level/scope filter and a line limit.
export function readLogs({ limit = 100, level = 'info', scope = null } = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('app-') && f.endsWith('.jsonl'))
      .sort((x, y) => (x < y ? 1 : -1));

    const collected = [];
    const minLevel = LEVELS[level] ?? 0;

    for (const file of files) {
      const raw = fs.readFileSync(path.join(LOG_DIR, file), 'utf-8');
      const lines = raw.split('\n');
      for (let k = lines.length - 1; k >= 0; k--) {
        const line = lines[k];
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if ((LEVELS[entry.level] ?? 0) < minLevel) continue;
        if (scope && entry.scope !== scope) continue;
        collected.push(entry);
        if (collected.length >= limit) return collected;
      }
    }
    return collected;
  } catch {
    return [];
  }
}

export function clearLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return 0;
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith('app-') && f.endsWith('.jsonl'));
    let count = 0;
    for (const f of files) {
      count += fs.readFileSync(path.join(LOG_DIR, f), 'utf-8').split('\n').filter((l) => l).length;
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
    return count;
  } catch {
    return 0;
  }
}
