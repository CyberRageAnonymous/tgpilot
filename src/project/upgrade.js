import fs from 'fs';
import path from 'path';
import { MODULE_ROOT, rootFileEntries, moduleDirs } from './layout.js';
import { findLegacyEntries } from './root.js';
import { info, success } from '../output.js';
import { log } from '../logs.js';

// One-time move of a pre-module-root layout under the module root. The
// snapshot holds the same files under module names already, so nothing needs
// to be redeployed afterwards.

export function upgradeLayout({ dryRun = false } = {}) {
  const entries = findLegacyEntries();
  if (entries.length === 0) return { moved: [], none: true };

  const dirNames = new Set(moduleDirs());
  const rootNames = new Set(rootFileEntries().map((f) => f.name));
  const moved = [];

  const rename = (from, to) => {
    moved.push({ from, to });
  };

  const plan = ({ execute }) => {
    if (!fs.existsSync(MODULE_ROOT)) {
      if (execute) fs.mkdirSync(MODULE_ROOT, { recursive: true });
    }
    for (const entry of entries) {
      if (entry.endsWith('/')) {
        const dir = entry.slice(0, -1);
        const from = path.join(dir);
        const to = path.join(MODULE_ROOT, dir);
        if (execute) {
          fs.renameSync(from, to);
        }
        rename(from, to);
        continue;
      }
      if (!rootNames.has(entry)) continue;
      const from = entry;
      const to = path.join(MODULE_ROOT, entry);
      if (execute) {
        if (fs.existsSync(to)) {
          info(`${MODULE_ROOT}/${entry} already exists; keeping both copies.`);
          continue;
        }
        fs.renameSync(from, to);
      }
      rename(from, to);
    }
  };

  if (dryRun) {
    plan({ execute: false });
  } else {
    plan({ execute: true });
    log('info', 'upgrade', 'Project layout upgraded to the tgcloud/ folder.', { moved: moved.map((m) => m.to) });
  }

  return { moved, none: false, dryRun: Boolean(dryRun) };
}
