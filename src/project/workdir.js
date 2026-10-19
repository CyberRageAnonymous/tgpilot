import fs from 'fs';
import path from 'path';
import { toPosix } from './snapshot.js';
import { MODULE_ROOT } from './layout.js';

// Module paths ("handlers/message.js", relative to the module root, with the
// .js extension) mapped to their on-disk location under the project root.

export function moduleToDisk(modulePath) {
  return path.join(MODULE_ROOT, ...toPosix(modulePath).split('/'));
}

export function displayPath(modulePath) {
  return `${MODULE_ROOT}/${toPosix(modulePath)}`;
}

// A user-typed target may carry the tgcloud/ prefix; normalize it to module space.
export function toModulePath(input) {
  const value = toPosix(String(input));
  const prefix = `${MODULE_ROOT}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function existsDisk(modulePath) {
  return fs.existsSync(moduleToDisk(modulePath));
}

export function readDisk(modulePath) {
  return fs.readFileSync(moduleToDisk(modulePath), 'utf-8');
}

export function writeDisk(modulePath, content) {
  const target = moduleToDisk(modulePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function unlinkDisk(modulePath) {
  const target = moduleToDisk(modulePath);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
