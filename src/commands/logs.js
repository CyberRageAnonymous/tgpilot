import { parseArgs } from '../args.js';
import { info } from '../output.js';
import { c } from '../colors.js';
import { readLogs, clearLogs, LEVELS } from '../logs.js';

// Reads back the JSONL journal under .tgpilot/logs/ (newest first).

export async function registerLogs(argv) {
  const args = parseArgs(argv, {
    flags: ['json', 'clear'],
    values: ['n', 'level', 'scope'],
  });

  if (args.flags.clear) {
    clearLogs();
    info('Log journal cleared.');
    return 0;
  }

  const level = args.values.level || 'info';
  if (!(level in LEVELS)) {
    throw new Error(`Unknown --level "${level}" — choose from: ${Object.keys(LEVELS).join(', ')}.`)
  }

  const scope = args.values.scope || null;
  let limit = Number(args.values.n ?? 100);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;

  const entries = readLogs({ limit, level, scope });
  if (!entries.length) {
    info('Nothing in the journal yet.');
    return 0;
  }

  if (args.flags.json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  for (const entry of entries) {
    const time = entry.t ? entry.t.slice(0, 19).replace('T', ' ') : '?';
    const levelTag = entry.level === 'error' ? c.red(entry.level.padEnd(5))
      : entry.level === 'warn' ? c.yellow(entry.level.padEnd(5))
      : c.dim(entry.level.padEnd(5));
    const scopeTag = entry.scope ? c.blue(` [${entry.scope}]`) : '';
    console.log(`${c.dim(time)}  ${levelTag}${scopeTag}  ${entry.msg}`);
    if (entry.data && Object.keys(entry.data).length !== 0) {
      console.log(c.dim('       data: ' + JSON.stringify(entry.data)));
    }
  }
  return 0;
}
