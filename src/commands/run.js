import { parseArgs } from '../args.js';
import { fatal, fail } from '../output.js';
import { c } from '../colors.js';
import { withToken } from '../project/credentials.js';
import { syncCapabilities, runnableDirs } from '../project/layout.js';
import { scanFiles } from '../project/scanner.js';
import { pathToModule, toPosix } from '../project/snapshot.js';
import { readDisk, existsDisk, displayPath, toModulePath } from '../project/workdir.js';
import { runFunction } from '../api/endpoints.js';
import { serverErrorText } from '../api/client.js';
import { stringify, parse } from '../json5.js';
import { createSpinner } from '../spinner.js';
import { formatRunHeader, formatRunLogs, formatRunReturn } from '../runlog.js';
import { log } from '../logs.js';

// `args` and `ctx` must be objects; the server rejects anything else.
function requireObject(value, what, example) {
  if (value === undefined) return;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return;
  const got = Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`;
  fatal(`${what} must be an object, e.g. '${example}' — got ${got}.`);
}

function isRunnable(modulePath, runnable) {
  return [...runnable].some((dir) => modulePath.startsWith(`${dir}/`));
}

// Resolve the user's module argument against the scanned set: bare names are
// looked up in every runnable directory, paths are taken as-is.
export function resolveRunnablePath(input, { scanned, runnable, exists = existsDisk }) {
  const allowed = new Set(scanned.filter((p) => isRunnable(p, runnable)));
  const candidates = [];

  const hadSep = input.includes('/');
  const mod = toModulePath(input);
  const withExt = mod.endsWith('.js') ? mod : `${mod}.js`;

  if (hadSep) {
    candidates.push(withExt);
  } else {
    for (const dir of runnable) candidates.push(`${dir}/${withExt}`);
  }

  const found = candidates.map(toPosix).filter((p) => allowed.has(p) && exists(p));
  if (found.length > 1) return { error: { kind: 'ambiguous', candidates: found } };
  if (found.length === 1) return { path: found[0] };

  for (const candidate of candidates) {
    const normalized = toPosix(candidate);
    if (exists(normalized) && !isRunnable(normalized, runnable)) {
      return { error: { kind: 'not-runnable', path: normalized } };
    }
  }

  return { error: { kind: 'not-found', candidates: candidates.map(toPosix) } };
}

export async function registerRun(argv0) {
  // First token is the module; anything after may carry --ctx as a JSON5 value.
  const parts = Array.from(argv0);
  let ctx;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === '--ctx') {
      const value = parts.splice(i, 2);
      ctx = value[1];
      break;
    }
  }
  const moduleArg = parts.shift();
  const argsArg = parts.length ? parts.join(' ') : undefined;

  await syncCapabilities();

  if (moduleArg === undefined) {
    fatal('Usage: tgpilot run <module> [args] — e.g. tgpilot run message \'{ text: "hi" }\'');
  }

  const runnable = runnableDirs();
  const res = resolveRunnablePath(moduleArg, { scanned: scanFiles(), runnable });
  if (!res.path) {
    const e = res.error;
    if (e.kind === 'ambiguous') {
      fatal(`"${moduleArg}" matches ${e.candidates.map(displayPath).join(' and ')} — name the directory, e.g. "${pathToModule(e.candidates[0])}".`);
    }
    if (e.kind === 'not-runnable') {
      fatal(
        `${displayPath(e.path)} is not runnable. Only modules in ${[...runnable].map((d) => displayPath(`${d}/`)).join(' and ')} can be run.`
      );
    }
    if (e.candidates.length === 1) {
      fatal(`Module not found: ${displayPath(e.candidates[0])}. Run "tgpilot status" to see your modules.`);
    }
    fatal(`Module not found in any of: ${e.candidates.map(displayPath).join(', ')}. Run "tgpilot status" to see your modules.`);
  }

  const modulePath = res.path;
  const moduleName = pathToModule(modulePath);

  let args;
  if (argsArg !== undefined) {
    try {
      args = parse(argsArg);
    } catch (err) {
      fatal(`Invalid JSON5 in args: ${err.message}`);
    }
  }
  if (ctx !== undefined) {
    try {
      ctx = parse(ctx);
    } catch (err) {
      fatal(`Invalid JSON5 in --ctx: ${err.message}`);
    }
  }
  requireObject(args, 'args', '{ text: "hi" }');
  requireObject(ctx, '--ctx', '{ update: { update_id: 1 } }');

  // Every local module goes up: the server resolves imports against this map
  // only, not against what is deployed.
  const sources = {};
  for (const f of scanFiles()) sources[pathToModule(f)] = readDisk(f);
  if (!(moduleName in sources)) {
    fatal(`Internal: ${displayPath(modulePath)} is not among the collected sources.`);
  }

  console.log(formatRunHeader(moduleName, args));
  const spinner = createSpinner('Running…');
  spinner.start();

  try {
    await withToken(async (token) => {
      let result;
      try {
        result = await runFunction(token, moduleName, sources, args, ctx);
      } finally {
        spinner.stop();
      }

      for (const line of formatRunLogs(result.log)) console.log(line);
      console.log(formatRunReturn(result.result, result.time));

      const durationMs = result.time != null ? Math.round(result.time * 1000) : null;
      log('info', 'run', 'Run completed.', {
        module: moduleName,
        logs: Array.isArray(result.log) ? result.log.length : 0,
        durationMs,
      });
    });
  } catch (err) {
    // The server places the run's own logs on the error, so they print first.
    const params = err?.parameters || {};
    for (const line of formatRunLogs(params.log)) console.log(line);
    const ms = params.time != null ? Math.max(0, Math.round(params.time * 1000)) : null;
    const suffix = ms != null ? c.dim(`  ${ms}ms`) : '';
    fail(`${serverErrorText(err)}${suffix}`.replace(/\n/g, '\n'));
    log('error', 'run', 'Run failed.', { module: moduleName, error: err?.description || String(err) });
    process.exit(1);
  }
  return 0;
}
