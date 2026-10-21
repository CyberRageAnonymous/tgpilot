import fs from 'fs';
import path from 'path';
import { MODULE_ROOT } from './layout.js';
import { ensureStateDir, profileStateDir } from './state.js';

// Every bot in a folder has its own copy of the code. The folder you see is
// the copy of the bot that is active: switching bots brings that bot's files
// in, and unlinking a bot takes its files out of the folder.
//
// The copies live under `.tgpilot/profiles/<name>/workspace/`, never in the
// deployed space, and are never pushed.

const MANAGED_ROOTS = [MODULE_ROOT, 'dist'];

function workspaceDir(profile) {
  return path.join(profileStateDir(profile), 'workspace');
}

// The files that belong to a bot: the modules and the Mini App build.
function managedFiles(root) {
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
  for (const dir of MANAGED_ROOTS) walk(dir);
  return files;
}

function copyInto(from, to, rel) {
  const source = path.join(from, rel);
  const target = path.join(to, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function removeEmptyParents(root, rel) {
  let current = path.dirname(path.join(root, rel));
  while (current.startsWith(root) && current !== root) {
    try {
      if (fs.readdirSync(current).length) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// Puts the folder as it is now into the bot's own copy.
export function saveWorkspace(profile, root = process.cwd()) {
  const dir = workspaceDir(profile);
  fs.mkdirSync(dir, { recursive: true });
  const files = managedFiles(root);
  for (const rel of files) {
    try {
      copyInto(root, dir, rel);
    } catch {
      /* a file that vanished mid-copy is simply left out */
    }
  }
  return { dir, files: files.length };
}

// Brings a bot's copy into the folder. Files the copy does not have are
// removed from the folder: they belonged to the bot that was active before.
export function restoreWorkspace(profile, root = process.cwd()) {
  const dir = workspaceDir(profile);
  const known = new Set();
  if (fs.existsSync(dir)) {
    const walk = (rel) => {
      const abs = path.join(dir, rel);
      for (const name of fs.readdirSync(abs).sort()) {
        const child = path.join(rel, name);
        if (fs.statSync(path.join(dir, child)).isDirectory()) walk(child);
        else known.add(child);
      }
    };
    walk('.');
    for (const rel of known) {
      try {
        copyInto(dir, root, rel);
      } catch {
        /* a file that cannot be copied is skipped */
      }
    }
  }

  // What the folder holds that the bot's copy does not: it was written for
  // the other bot and goes away with it.
  for (const rel of managedFiles(root)) {
    if (known.has(rel)) continue;
    try {
      fs.rmSync(path.join(root, rel), { force: true });
      removeEmptyParents(root, rel);
    } catch {
      /* a file that cannot be removed stays; it is reported by the diff */
    }
  }
  return { files: [...known] };
}

// Empties the folder: there is no bot, so the folder has nothing to show.
// The files are not lost — they stay in the workspace of the bot that left.
export function clearWorkspace(root = process.cwd()) {
  for (const rel of managedFiles(root)) {
    try {
      fs.rmSync(path.join(root, rel), { force: true });
      removeEmptyParents(root, rel);
    } catch {
      /* a file that cannot be removed stays */
    }
  }
}

// Forgets a bot's copy completely.
export function dropWorkspace(profile) {
  const dir = workspaceDir(profile);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function workspaceExists(profile) {
  return fs.existsSync(workspaceDir(profile));
}

export function workspaceFiles(profile) {
  const dir = workspaceDir(profile);
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const child = path.join(rel, name);
      if (fs.statSync(path.join(dir, child)).isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk('.');
  return files;
}

export { ensureStateDir };
