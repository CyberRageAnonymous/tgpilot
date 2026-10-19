import fs from 'fs';
import { MODULE_ROOT, syncedDirs, rootFileEntries, findDisallowedModules } from './layout.js';
import { scanFiles } from './scanner.js';
import { localDiff } from './diff.js';
import { pathToModule, replaceSnapshot } from './snapshot.js';
import { readDisk, toModulePath } from './workdir.js';
import { loadProjectConfig, configFileName } from './config.js';
import { scanStatic, staticDiff, loadStaticSnapshot, saveStaticSnapshot } from './static.js';
import { getFiles, batchDeploy, prepareStatic, uploadBlob } from '../api/endpoints.js';
import { serverErrorText } from '../api/client.js';
import { withToken } from './credentials.js';
import { fatal, warn } from '../output.js';
import { loadState, saveState } from './state.js';

const SCHEMA_FILE = 'schema.js';
const UPLOAD_CONCURRENCY = 4;

// What a push would send, computed from disk only — no network, no printing.
// The CLI previews this and the studio renders the same shape.

export function makeStaticPlan(block) {
  if (!block) return null;
  const snapshot = loadStaticSnapshot();
  if (block.remove) return { remove: true, changed: Boolean(snapshot) };
  const scan = scanStatic(block.source);
  if (!scan) throw new Error(`Static source folder "${block.source}/" not found (see ${configFileName()} → static). Run the build first.`);
  if (Object.keys(scan.manifest).length === 0) {
    throw new Error(`Static source folder "${block.source}/" is empty. Run the build first.`);
  }
  const d = staticDiff(scan, block.config, snapshot);
  return { source: block.source, config: block.config, scan, diff: d, changed: d.changed };
}

// Scope of the push: everything, only some code files, or only the static build.
export function classifyTargets(targetFiles, projectConfig) {
  if (!targetFiles?.length) return { mode: 'all', wantsCode: true, wantsStatic: true, targetSet: null };

  const source = projectConfig.static?.source;
  const isStaticTarget = (raw) => source && toModulePath(raw).replace(/\/+$/, '') === source;
  const staticTargeted = targetFiles.some(isStaticTarget);
  const codeTargets = targetFiles.filter((raw) => !isStaticTarget(raw));

  let targetSet = null;
  if (codeTargets.length) {
    const { targets, bad } = resolveTargetSet(codeTargets, scanFiles());
    if (bad.length) {
      throw new Error(`Nothing to deploy for: ${bad.join(', ')}.\nRun "tgpilot status" to see what can be deployed.`);
    }
    targetSet = targets;
  }

  return {
    mode: codeTargets.length ? 'code' : 'static',
    wantsCode: codeTargets.length > 0,
    wantsStatic: !codeTargets.length,
    targetSet,
  };
}

// Map raw push targets (file paths, module names, directories) onto the
// scanned backend paths. No fs access: everything reads from `scanned`.
export function resolveTargetSet(rawTargets, scanned) {
  const scannedSet = new Set(scanned);
  const targets = new Set();
  const bad = [];
  for (const raw of rawTargets) {
    const norm = toModulePath(raw);
    const withExt = norm.endsWith('.js') ? norm : `${norm}.js`;
    if (scannedSet.has(withExt)) { targets.add(withExt); continue; }
    const dir = norm.replace(/\/+$/, '');
    const under = dir === '' || dir === MODULE_ROOT
      ? scanned.slice()
      : scanned.filter((p) => p.startsWith(`${dir}/`));
    if (under.length) {
      under.forEach((p) => targets.add(p));
      continue;
    }
    bad.push(raw);
  }
  return { targets, bad };
}

export function planPush({ targets, force = false } = {}) {
  // `force` only bypasses the revision check in settleRevision; planning is
  // identical either way.
  void force;
  const projectConfig = loadProjectConfig();
  const scope = classifyTargets(targets || [], projectConfig);

  const scanned = scanFiles();
  const disallowed = findDisallowedModules(scanned);
  if (disallowed.length) {
    const first = disallowed[0];
    throw new Error(
      `${first.file}: "${first.name}" is not a valid name inside ${first.dir}/. Allowed: ${first.allowed.join(', ')}.`
    );
  }

  const diff = localDiff();
  const staticPlan = scope.wantsStatic ? makeStaticPlan(projectConfig.static) : null;

  const changedPaths = [];
  const deletedPaths = [];
  const buckets = { modified: [], added: [], deleted: [], static: [] };

  if (scope.wantsCode) {
    for (const f of diff.modified) if (!scope.targetSet || scope.targetSet.has(f.path)) {
      changedPaths.push(f.path);
      buckets.modified.push(displayRel(f.path));
    }
    for (const f of diff.newLocal) if (!scope.targetSet || scope.targetSet.has(f.path)) {
      changedPaths.push(f.path);
      buckets.added.push(displayRel(f.path));
    }
    for (const f of diff.remoteOnly) if (!scope.targetSet || scope.targetSet.has(f.path)) {
      deletedPaths.push(f.path);
      buckets.deleted.push(displayRel(f.path));
    }
  }

  if (staticPlan?.changed) {
    if (staticPlan.remove) {
      buckets.static.push({ kind: 'remove' });
    } else {
      const { diff: staticDiffOut, source } = staticPlan;
      for (const p of staticDiffOut.added) buckets.static.push({ kind: 'added', path: `${source}/${p}` });
      for (const p of staticDiffOut.modified) buckets.static.push({ kind: 'modified', path: `${source}/${p}` });
      for (const p of staticDiffOut.deleted) buckets.static.push({ kind: 'deleted', path: `${source}/${p}` });
      if (staticDiffOut.configChanged) buckets.static.push({ kind: 'config' });
      if (staticPlan.scan.nonNfc.length) {
        warn(`${staticPlan.scan.nonNfc.length} path${staticPlan.scan.nonNfc.length === 1 ? ' is' : 's are'} not NFC-normalized (e.g. ${staticPlan.scan.nonNfc[0]}); ASCII names are safest for URLs.`);
      }
    }
  }

  const codeChanged = changedPaths.length + deletedPaths.length > 0;
  const staticChanged = Boolean(staticPlan?.changed);

  // The manifest always carries the full module set — anything missing from it
  // is deleted on the server. Targeted pushes keep untouched remote modules in
  // it, so a partial push never deletes.
  const synced = new Set(syncedDirs());
  const rootNames = rootFileEntries().map((f) => f.name);
  const inDeployedSpace = (modulePath) => rootNames.includes(modulePath) || synced.has(modulePath.split(/[\\/]/)[0]);
  const newLocalSet = new Set(diff.newLocal.map((f) => f.path));

  const manifestPaths = scanned.filter((p) => {
    if (!inDeployedSpace(p)) return false;
    if (scope.targetSet && newLocalSet.has(p) && !scope.targetSet.has(p)) return false;
    return true;
  });
  if (codeChanged && scope.targetSet) {
    for (const f of diff.remoteOnly) {
      if (inDeployedSpace(f.path) && scope.targetSet.has(f.path)) manifestPaths.push(f.path);
    }
  }

  const manifest = codeChanged ? [...new Set(manifestPaths.map(pathToModule))] : undefined;

  const changesForServer = {};
  for (const p of changedPaths) {
    if (!inDeployedSpace(p)) continue;
    changesForServer[pathToModule(p)] = readDisk(p);
  }

  return {
    projectConfig,
    scope,
    changedPaths,
    deletedPaths,
    buckets,
    changedCount: changedPaths.length + deletedPaths.length + (staticChanged ? 1 : 0),
    codeChanged,
    staticChanged,
    staticPlan,
    manifest,
    changesForServer,
    inDeployedSpace,
    schemaTouched: changedPaths.includes(SCHEMA_FILE),
  };
}

function displayRel(modulePath) {
  return modulePath;
}

// A bot that already holds content must never be overwritten by a folder that
// has never learned its revision — force, or a prior fetch/pull, unlocks it.
export async function settleRevision(plan, { force = false, token } = {}) {
  if (force) return { expected_revision: null };

  const expected = loadState().last_known_revision;
  if (expected != null) return { expected_revision: expected };

  const remote = token ? await getFiles(token) : await withToken((t) => getFiles(t));
  const remoteCount = Object.keys(remote?.canonical_modules || {}).length;

  if (remoteCount > 0 || remote?.static) {
    const what = remoteCount > 0
      ? `${remoteCount} deployed module${remoteCount === 1 ? '' : 's'}`
      : 'a deployed static site';
    const err = new Error(
      `The bot already has ${what}` +
      (remote.revision != null ? ` (revision ${remote.revision})` : '') +
      ', but this folder has never synced with it.\n' +
      'Run "tgpilot fetch", review, then push. Or "tgpilot push --force" to overwrite the bot.'
    );
    err.kind = 'undeclared_bot';
    err.remote = remote;
    throw err;
  }

  return { expected_revision: remote.revision ?? null };
}

// Static blobs go up before the deploy call, so a failed upload leaves the
// bot exactly as it was.
export async function sendDeploy(plan, { expected_revision, token, onUpload } = {}) {
  let staticSection;
  let uploaded = null;

  if (plan.staticChanged) {
    if (plan.staticPlan.remove) {
      staticSection = { hash: false };
    } else {
      uploaded = await uploadStatic(plan.staticPlan, token, onUpload);
      staticSection = { hash: uploaded.hash };
    }
  }

  const response = await batchDeploy(token, {
    expected_revision,
    manifest: plan.manifest,
    changed_sources: plan.changesForServer,
    static: staticSection,
  });

  return { response, uploaded, staticSection };
}

// Record the deployed state locally. `staticSection` echoes what this push
// sent: `{ hash: false }` means the removal went through even when the server
// response carries no static block at all.
export function absorbResponse(response, { staticSection } = {}) {
  if (response?.canonical_modules) replaceSnapshot(response.canonical_modules);
  if (staticSection && staticSection.hash === false) {
    saveStaticSnapshot(null);
  } else if (response && 'static' in response) {
    saveStaticSnapshot(response.static ?? null);
  }
  if (response?.revision != null) {
    const state = loadState();
    state.last_known_revision = response.revision;
    saveState(state);
  }
}

export async function uploadStatic(plan, token, onUpload) {
  const { manifest, abs } = plan.scan;
  const byHash = new Map(Object.entries(manifest).map(([p, e]) => [e.hash, p]));

  const prepared = await prepareStatic(token, manifest, plan.config);
  const missing = Array.isArray(prepared?.missing) ? prepared.missing : [];
  const bytes = missing.reduce((n, hash) => n + (manifest[byHash.get(hash)]?.size ?? 0), 0);
  if (missing.length === 0) return { hash: prepared?.hash ?? '', count: 0, bytes: 0 };

  let sent = 0;
  const queue = [...missing];
  const worker = async () => {
    for (;;) {
      const hash = queue.shift();
      if (hash === undefined) return;
      const rel = byHash.get(hash);
      if (rel === undefined) continue;
      const buf = fs.readFileSync(abs[rel]);
      await uploadWithRetry(token, hash, prepared.hash, buf);
      sent++;
      if (onUpload) onUpload({ done: sent, total: missing.length, bytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, worker));
  return { hash: prepared.hash, count: missing.length, bytes };
}

async function uploadWithRetry(token, hash, bundle, bytes) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadBlob(token, hash, bundle, bytes);
    } catch (err) {
      const wait = Number(err?.parameters?.retry_after);
      if (err?.type === 'RATE_LIMITED' && attempt < 3 && Number.isFinite(wait) && wait > 0) {
        await new Promise((exit) => setTimeout(exit, Math.min(wait, 60) * 1000));
        continue;
      }
      if (err && typeof err === 'object') err.parameters = { ...(err.parameters || {}), hash };
      throw err;
    }
  }
}

// Turn a failed static upload into a message about a file, not a hash.
export function describeStaticError(err, staticPlan) {
  const base = serverErrorText(err);
  const hash = err?.parameters?.hash;
  const rel = hash && staticPlan?.scan
    ? Object.entries(staticPlan.scan.manifest).find(([, e]) => e.hash === hash)?.[0]
    : undefined;
  const file = rel && staticPlan ? `${staticPlan.source}/${rel}` : null;

  switch (err?.type) {
    case 'FORBIDDEN_TYPE':
      return `${file ?? base}: executable content is not allowed in Mini App files. Remove it from the build output and push again.`;
    case 'SIZE_MISMATCH':
    case 'HASH_MISMATCH':
    case 'LENGTH_MISMATCH':
      return `${file ? file + ': ' : ''}${base} The build output changed while pushing — push again.`;
    case 'STATIC_NOT_PREPARED':
      return `${base} The upload window expired — push again.`;
    case 'RATE_LIMITED':
      return `${base} Try again in ${err?.parameters?.retry_after ?? 'a few'} seconds.`;
    default:
      if (err?.status === 413 && !err?.type) {
        const size = rel ? formatBytes(staticPlan.scan.manifest[rel].size) : null;
        return `${file ?? 'the upload'}${size ? ` (${size})` : ''}: the server refused it as too large.`;
      }
      return file && rel && !base.includes(rel) ? `${file}: ${base}` : base;
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function isRevisionMismatch(err) {
  if (err?.type === 'REVISION_MISMATCH') return true;
  const p = err?.parameters || {};
  return typeof p.current_revision === 'number' || err?.status === 409;
}
