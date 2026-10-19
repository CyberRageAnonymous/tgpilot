import fs from 'fs';
import path from 'path';
import { warn, info, fatal } from '../output.js';
import { ROOT_FILES, MODULE_ROOT, moduleDirs, nestableDirs } from './layout.js';
import { moduleToDisk, displayPath } from './workdir.js';

// Scans the deployable set: the root files plus every .js file inside the
// module directories. Paths come back POSIX-normalized so Windows paths and
// server module names always agree.

export function scanFiles() {
  const files = [];

  for (const rootFile of ROOT_FILES) {
    if (fs.existsSync(moduleToDisk(rootFile))) files.push(rootFile);
  }

  for (const dir of moduleDirs()) {
    if (!fs.existsSync(moduleToDisk(dir))) continue;
    collectJs(dir, files);
  }

  return files.map((f) => f.split(/[\\/]/).join('/'));
}

function collectJs(startDir, out) {
  const nestable = nestableDirs();
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(moduleToDisk(dir), { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!nestable.has(base)) {
          const allowed = [...nestable].map((d) => `${d}/`).join(', ');
          fatal(
            `${displayPath(base)}/ must stay flat, but ${displayPath(child)}/ is a folder. ` +
            (allowed ? `Only ${allowed} allow subfolders.` : 'No module directory allows subfolders.')
          );
        }
        walk(child, base);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(child);
      }
    }
  };
  walk(startDir, startDir);
}

// .js files that sit where nothing is deployable: in the module root next to
// the real module directories, or below a folder that is not a module directory.
export function findStrayFiles() {
  const rootFiles = new Set(ROOT_FILES);
  const dirs = new Set(moduleDirs());
  let entries;
  try {
    entries = fs.readdirSync(MODULE_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) {
      if (entry.name.endsWith('.js') && !rootFiles.has(entry.name)) out.push(displayPath(entry.name));
    } else if (entry.isDirectory() && !dirs.has(entry.name)) {
      walkStrays(entry.name, out);
    }
  }
  return out;
}

function walkStrays(start, out) {
  const walk = (rel) => {
    for (const entry of fs.readdirSync(moduleToDisk(rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(displayPath(child));
    }
  };
  walk(start);
}

export function warnStrayFiles() {
  const strays = findStrayFiles();
  if (strays.length === 0) return strays;
  info('');
  warn(`Stray .js file${strays.length === 1 ? '' : 's'} that won't be deployed:`);
  for (const f of strays) info(`  ${f}`);
  const dirs = moduleDirs().map((d) => `${d}/`).join(', ');
  info(`Move files into ${dirs} to deploy them.`);
  return strays;
}
