import { c } from './colors.js';
import { stringify } from './json5.js';

// Formats what a server-side run reports: log entries and the return value.
// A log entry looks like { _: "log"|"dbg"|"inf"|"wrn"|"err", t: <seconds>,
// m: <message> or M: <truncated>, o: <origin> }.

export function formatRunHeader(moduleName, args) {
  const baseName = moduleName.split('/').pop();
  let argsText = '';
  if (args !== undefined) {
    try {
      argsText = stringify(args);
    } catch {
      argsText = String(args);
    }
  }
  return c.cyan('> ') + `${baseName}(${argsText})`;
}

export function formatRunLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return [];

  const lines = [];
  let prevMs = 0;

  for (const entry of logs) {
    const tMs = (entry.t || 0) * 1000;
    const deltaMs = Math.max(0, tMs - prevMs);
    prevMs = tMs;

    const truncated = entry.M != null;
    const rawMessage = truncated ? entry.M : entry.m ?? '';

    const message = colorize(entry._, rawMessage);
    const truncSuffix = truncated ? c.dim(' …[truncated]') : '';
    const time = c.dim(`+${formatMs(deltaMs)}`);
    const origin = formatOrigin(entry.o);
    const originText = origin ? '  ' + c.dim(`[${origin}]`) : '';

    lines.push(`${typePrefix(entry._)} ${message}${truncSuffix}  ${time}${originText}`);
  }

  return lines;
}

function colorize(type, text) {
  if (type === 'wrn') return c.yellow(text);
  if (type === 'err') return c.red(text);
  return String(text);
}

// The origin shows up as a string ("handlers/message:6") or an object
// ({ m, l } or { module, line }).
function formatOrigin(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (typeof o === 'object') {
    const mod = o.m ?? o.module;
    const line = o.l ?? o.line;
    if (mod != null && line != null) return `${mod}:${line}`;
    if (mod != null) return String(mod);
  }
  return '';
}

export function formatRunReturn(value, totalSeconds) {
  const valueText = c.bold(formatValue(value));
  const timeText = totalSeconds != null ? c.dim(`  ${formatMs(totalSeconds * 1000)}`) : '';
  return c.cyan('< ') + valueText + timeText;
}

function typePrefix(type) {
  switch (type) {
    case 'inf': return c.blue('i');
    case 'wrn': return c.yellow('!');
    case 'err': return c.red('x');
    default: return ' ';
  }
}

export function formatValue(v) {
  if (v === undefined) return c.dim('undefined');
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.__error) {
    return c.red(`Error: ${v.message || ''}`);
  }
  try {
    return stringify(v);
  } catch {
    return String(v);
  }
}

function formatMs(ms) {
  return Math.max(0, Math.round(ms)) + 'ms';
}
