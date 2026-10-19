const NO_COLOR = process.env.NO_COLOR !== undefined;
const FORCE_COLOR = process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true';
const TTY = process.stdout.isTTY === true || process.stderr.isTTY === true;

export const enabled = !NO_COLOR && (FORCE_COLOR || TTY);

function wrap(code, text) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

export const c = {
  dim: (s) => wrap(2, s),
  red: (s) => wrap(31, s),
  green: (s) => wrap(32, s),
  yellow: (s) => wrap(33, s),
  blue: (s) => wrap(34, s),
  magenta: (s) => wrap(35, s),
  cyan: (s) => wrap(36, s),
  bold: (s) => wrap(1, s),
};

// Remove ANSI sequences as well as control characters; used when writing
// server-provided strings to places that must stay plain, like the journal.
export function plain(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
