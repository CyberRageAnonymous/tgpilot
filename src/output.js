import { c } from './colors.js';

export function fatal(message) {
  console.error(``
    + c.red('Error: ') + String(message));
  process.exit(1);
}

export function fail(message) {
  console.error(c.red('Error: ') + String(message));
}

export function warn(message) {
  console.log(c.yellow('Warning: ') + String(message));
}

export function info(message) {
  console.log(String(message));
}

export function success(message) {
  console.log(c.green('✓ ') + message);
}

// Per-file result lines, ready to sort by type.
export function done(path, note) {
  console.log(c.green('✓ ') + path + (note ? c.dim(` (${note})`) : ''));
}

export function skipped(path, note) {
  console.log(c.dim(`⊘ ${path}`) + (note ? c.dim(` (${note})`) : ''));
}

export function changed(path) {
  console.log(c.yellow('~ ') + path);
}

export function newFile(path) {
  console.log(c.green('+ ') + path);
}

export function deleted(path) {
  console.log(c.red('− ') + path);
}
