import fs from 'fs';
import path from 'path';
import { createProjectFs } from './projectfs.js';
import { syncCapabilities, moduleDirs, runnableDirs, scaffoldEntries, findDisallowedModules } from '../project/layout.js';
import { scanFiles, findStrayFiles } from '../project/scanner.js';
import { localDiff } from '../project/diff.js';
import { peekToken, maskToken, tokenEnvName, verifyToken, unlinkBot } from '../project/credentials.js';
import { planPush, makeStaticPlan, settleRevision, sendDeploy, absorbResponse, isRevisionMismatch } from '../project/deploy.js';
import { runFunction, getWebhook, syncWebhook, getMigrationStatus, applyMigration, getFiles } from '../api/endpoints.js';
import { replaceSnapshot, readSnapshotFile, snapshotExists, pathToModule } from '../project/snapshot.js';
import { loadState, saveState, saveCredentials, loadCredentials } from '../project/state.js';
import { saveStaticSnapshot, loadStaticSnapshot, scanStatic, staticDiff, formatBytes } from '../project/static.js';
import { loadProjectConfig, configFileName } from '../project/config.js';
import { readDisk, writeDisk, unlinkDisk, existsDisk, displayPath } from '../project/workdir.js';
import { changeCard, changeId } from '../project/changes.js';
import { serverErrorText, requestPublic, invalidateNetworkCache } from '../api/client.js';
import { networkConfig, saveNetworkConfig, diagnose } from '../project/network.js';
import { log, readLogs, clearLogs, LEVELS } from '../logs.js';
import { moduleStarter, UPDATE_TYPES, SCHEMA_STARTER } from '../templates.js';
import { parse } from '../json5.js';
import { computeDiff } from '../diff.js';
import { resolveRunnablePath } from '../commands/run.js';

const SCHEMA_FILE = 'schema.js';

// The JSON API of the studio. The token stays server-side; the browser talks
// to localhost and the server talks to cloud.telegram.org.

export function createRoutes(root, uiDir) {
  const project = createProjectFs(root);
  const ui = loadUi(uiDir);

  const routes = new Map([
    ['GET /api/project', () => handleProjectInfo(project)],
    ['GET /api/tree', () => handleTree(project)],
    ['GET /api/list', (body, query) => handleList(project, query)],
    ['GET /api/starter', (body, query) => handleStarter(query)],
    ['GET /api/file', (body, query) => handleFileRead(project, query)],
    ['POST /api/file', (body) => handleFileWrite(project, body)],
    ['DELETE /api/file', (body) => handleFileDelete(project, body)],
    ['GET /api/status', () => handleStatus()],
    ['POST /api/bot', (body) => handleBotLink(body)],
    ['DELETE /api/bot', () => handleBotUnlink()],
    ['POST /api/push', (body) => handlePush(body)],
    ['POST /api/fetch', () => handleFetch()],
    ['POST /api/run', (body) => handleRun(body)],
    ['GET /api/migrate', () => handleMigrateCheck()],
    ['POST /api/migrate', (body) => handleMigrateApply(body)],
    ['GET /api/webhook', () => handleWebhookGet()],
    ['POST /api/webhook', (body) => handleWebhookSync(body)],
    ['GET /api/schema', () => handleSchemaDiff()],
    ['GET /api/logs', (body, query) => handleLogsGet(query)],
    ['DELETE /api/logs', () => handleLogsClear()],
    ['GET /api/network', () => handleNetworkGet()],
    ['POST /api/network', (body) => handleNetworkSave(body)],
    ['POST /api/network/test', (body) => handleNetworkTest(body)],
  ]);

  return async ({ req, res }, next) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    if (ui && !key.startsWith('GET /api/') && !req.url.includes('/static/')) {
      if (key === 'GET /' || key === 'GET /index.html') return sendFile(res, ui, 'html');
      if (key === 'GET /style.css') return sendFile(res, ui, 'css');
      if (key === 'GET /app.js') return sendFile(res, ui, 'js');
    }

    const handler = routes.get(key);
    if (!handler) return next();

    try {
      const body = await readBody(req);
      if (body === TOO_LARGE) return fail(res, 413, 'Request body too large');
      if (body === BAD_JSON) return fail(res, 400, 'Request body must be JSON');
      const out = await handler(body, url.searchParams);
      send(res, out.status || 200, out);
    } catch (err) {
      // Avoid echoing the log of a run request into an error payload.
      if (isRevisionMismatch(err)) {
        send(res, 409, {
          ok: false,
          error: serverErrorText(err),
          kind: 'revision',
          current_revision: err?.parameters?.current_revision ?? null,
        });
      } else {
        // Raw undici errors would surface as just "fetch failed" in the
        // browser; serverErrorText turns outages into a human sentence.
        send(res, err.status || 500, {
          ok: false,
          error: serverErrorText(err),
          kind: err.kind || err.type || 'error',
        });
      }
    }
    return true;
  };
}

function send(res, status, out) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(out));
}

function fail(res, status, message, kind) {
  send(res, status, { ok: false, error: message, kind: kind || 'error' });
}

function sendFile(res, ui, what) {
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': cssJs[what] || 'text/plain' });
  res.end(ui[what]);
}

const cssJs = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

function loadUi(uiDir) {
  if (!uiDir) return null;
  const read = (name, fallback) => {
    try {
      return fs.readFileSync(path.join(uiDir, name), 'utf-8');
    } catch {
      return fallback;
    }
  };
  return {
    html: read('index.html', '<h1>tgpilot</h1><p>studio files are missing.</p>'),
    css: read('style.css', ''),
    js: read('app.js', 'console.warn("studio app missing");'),
  };
}

const TOO_LARGE = Symbol('too large');
const BAD_JSON = Symbol('bad json');

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) {
        done = true;
        resolve(TOO_LARGE);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (done) return;
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(BAD_JSON);
      }
    });
    req.on('error', () => {
      if (!done) resolve(null);
    });
  });
}

function badRequest(message, kind) {
  const err = new Error(message);
  err.status = 400;
  err.kind = kind || 'bad-request';
  return err;
}

// --- endpoints ------------------------------------------------------------

async function handleProjectInfo(project) {
  const descriptor = await syncCapabilities();
  let staticBlock = null;
  try { staticBlock = loadProjectConfig({ tolerant: true }).static || null; } catch { staticBlock = null; }
  return {
    ok: true,
    root: project.root,
    token: peekToken() ? { masked: maskToken(peekToken()), fromEnv: Boolean(tokenEnvName()) } : null,
    dirs: moduleDirs(),
    runnable: [...runnableDirs()],
    scaffold: scaffoldEntries(),
    configFileName: configFileName(),
    schemaVersion: descriptor?.project_schema_version ?? null,
    handlerTypes: UPDATE_TYPES,
    static: staticBlock && !staticBlock.remove
      ? { source: staticBlock.source, spa: staticBlock.config?.spa === true }
      : null,
  };
}

function handleTree(project) {
  // Each node carries its project-relative path so the UI needs no DOM
  // guessing to open or save a file.
  const walk = (rel, depth) => project
    .list(rel)
    .map((entry) => {
      const full = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.dir && depth < 3
        ? { ...entry, path: full, children: walk(full, depth + 1) }
        : { ...entry, path: full };
    });
  return { ok: true, tree: walk('', 0) };
}

function handleList(project, query) {
  // One flat folder listing for the studio's section views; '' is the root.
  const rel = query?.get('path') || '';
  return { ok: true, path: rel, entries: project.list(rel) };
}

function handleStarter(query) {
  // The studio creates modules from the same starters the CLI scaffolds.
  const kind = query?.get('kind');
  const name = query?.get('name') || '';
  if (kind === 'schema') return { ok: true, content: SCHEMA_STARTER };
  if (!['handlers', 'endpoints', 'lib'].includes(kind)) throw badRequest('Unknown module kind');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw badRequest('Bad module name');
  return { ok: true, content: moduleStarter(kind, name) };
}

function handleFileRead(project, query) {
  const rel = query?.get('path');
  if (!rel) throw badRequest('Missing ?path=');
  return { ok: true, path: rel, content: project.read(rel) };
}

async function handleFileWrite(project, body) {
  if (!body || typeof body.path !== 'string') throw badRequest('Missing "path"');
  if (typeof body.content !== 'string') throw badRequest('Missing "content"');
  project.write(body.path, body.content);
  return { ok: true };
}

function handleFileDelete(project, body) {
  if (!body || typeof body.path !== 'string') throw badRequest('Missing "path"');
  project.remove(body.path);
  return { ok: true };
}

async function handleStatus() {
  const token = peekToken();
  const state = loadState();
  const diff = localDiff();
  const strays = findStrayFiles();

  const display = (bucket) => bucket.map((f) => displayPath(f.path));
  const staticInfo = staticStatusInfo();

  let webhook = null;
  if (token) {
    try {
      webhook = await Promise.race([
        getWebhook(token),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
      ]);
    } catch {
      webhook = null;
    }
  }

  return {
    ok: true,
    token: token ? { masked: maskToken(token), fromEnv: Boolean(tokenEnvName()) } : null,
    revision: state.last_known_revision ?? null,
    modified: display(diff.modified),
    added: display(diff.newLocal),
    deleted: display(diff.remoteOnly),
    strays: strays.map((s) => s),
    static: staticInfo,
    webhook: webhook ? {
      url: webhook.url || null,
      pending: webhook.pending_update_count ?? 0,
      inSync: Boolean(webhook.in_sync),
    } : null,
  };
}

function staticStatusInfo() {
  let block;
  try {
    block = loadProjectConfig({ tolerant: true }).static;
  } catch {
    return { configError: true };
  }
  const snapshot = loadStaticSnapshot();
  if (!block) return { configured: false, deployed: Boolean(snapshot) };
  if (block.remove) return { configured: true, removing: true, deployed: Boolean(snapshot) };

  const scan = scanStatic(block.source);
  if (!scan) return { configured: true, source: block.source, missing: true };
  const d = staticDiff(scan, block.config, snapshot);
  return {
    configured: true,
    source: block.source,
    missing: false,
    added: d.added,
    modified: d.modified,
    deleted: d.deleted,
    configChanged: d.configChanged,
    unchanged: d.unchanged,
    changed: d.changed,
    size: Object.values(scan.manifest).reduce((n, e) => n + e.size, 0),
  };
}

async function handleBotLink(body) {
  const raw = String(body?.token || '').trim();
  if (!raw) throw badRequest('Missing "token"');
  const check = await verifyToken(raw);
  if (!check.ok && !check.network) {
    throw badRequest('The server rejected that token. Get a fresh one from @BotFather (bot → Serverless → CLI Access).', 'rejected');
  }
  saveCredentials(raw);
  log('info', 'login', 'Project linked from the studio.', { token: maskToken(raw) });
  return {
    ok: true,
    token: { masked: maskToken(raw), unverified: check.network || undefined },
  };
}

function handleBotUnlink() {
  const saved = loadCredentials();
  unlinkBot();
  log('info', 'logout', 'Token removed from the studio.', { token: maskToken(saved?.token) });
  return { ok: true };
}

// POST /api/push: preview first, then {confirm: true} to actually deploy.
async function handlePush(body) {
  await syncCapabilities();

  const plan = planPush({ targets: body?.targets || [], force: body?.force === true });
  const token = requiredToken();

  if (!body?.confirm) {
    return {
      ok: true,
      preview: true,
      changedCount: plan.changedCount,
      modified: plan.buckets.modified.map(displayPath),
      added: plan.buckets.added.map(displayPath),
      deleted: plan.buckets.deleted.map(displayPath),
      static: plan.buckets.static,
      deletionsRequireConfirm: plan.deletedPaths.length > 0 && body?.force !== true,
      schemaTouched: plan.schemaTouched,
    };
  }

  const started = Date.now();
  if (!plan.changedCount) return { ok: true, nothing: true };

  const settled = await settleRevision(plan, {
    force: body?.force === true,
    token,
  });
  const sent = await sendDeploy(plan, {
    expected_revision: settled.expected_revision,
    token,
  });
  absorbResponse(sent.response);

  log('info', 'push', 'Deploy finished (studio).', {
    changed: plan.changedPaths.length,
    deleted: plan.deletedPaths.length,
    staticUploaded: sent.uploaded?.count ?? 0,
    revision: sent.response?.revision ?? null,
    durationMs: Date.now() - started,
  });

  return {
    ok: true,
    revision: sent.response?.revision ?? null,
    staticUrl: sent.response?.static?.url ?? null,
    uploaded: sent.uploaded ? { count: sent.uploaded.count, size: formatBytes(sent.uploaded.bytes) } : null,
    dbChanges: sent.response?.db_changes || null,
  };
}

// Web requests resolve the token straight from disk/env; a missing or expired
// one answers as HTTP 401 and the studio shows the Link panel again.
function requiredToken() {
  const token = peekToken();
  if (!token) {
    const err = new Error('Not linked to a bot yet — paste the @BotFather access token on the Link panel.');
    err.status = 401;
    err.kind = 'auth';
    throw err;
  }
  return token;
}

async function handleFetch() {
  const response = await getFiles(requiredToken());
  const canonical = response.canonical_modules || {};
  replaceSnapshot(canonical);
  if ('static' in response) saveStaticSnapshot(response.static);
  if (response.revision != null) {
    const state = loadState();
    state.last_known_revision = response.revision;
    saveState(state);
  }
  const snapshotNow = { count: Object.keys(canonical).length, revision: response.revision ?? null };
  log('info', 'fetch', 'Snapshot refreshed (studio).', snapshotNow);
  return { ok: true, ...snapshotNow };
}

async function handleRun(body) {
  if (typeof body?.module !== 'string' || !body.module) throw badRequest('Missing "module"');

  let args = body.args;
  if (typeof args === 'string') {
    try {
      args = parse(args || '{}');
    } catch (err) {
      throw badRequest(`args is not valid JSON5: ${err.message}`);
    }
  }
  if (args === undefined || args === null || args === '') args = undefined;
  if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
    throw badRequest('args must be an object, e.g. {"text":"hi"}');
  }

  const runnable = runnableDirs();
  const res = resolveRunnablePath(body.module, { scanned: scanFiles(), runnable });
  if (!res.path) {
    const e = res.error;
    if (e.kind === 'ambiguous') {
      throw badRequest(`"${body.module}" matches ${e.candidates.map(displayPath).join(' and ')} — name the folder, e.g. "${e.candidates[0]}".`);
    }
    if (e.kind === 'not-runnable') {
      throw badRequest(`${displayPath(e.path)} is not runnable. Only modules in ${[...runnable].map((d) => `${d}/`).join(' and ')} can be run.`);
    }
    throw badRequest('Module not found. Pick one from handlers/ or endpoints/.');
  }
  const moduleName = pathToModule(res.path);

  // Every local module goes along, so imports resolve locally, not against
  // whatever is deployed.
  const sources = {};
  for (const f of scanFiles()) sources[pathToModule(f)] = readDisk(f);

  const result = await runFunction(requiredToken(), moduleName, sources, args, body.ctx || {});
  log('info', 'run', 'Run completed (studio).', { module: moduleName, logs: result.log?.length || 0 });
  return {
    ok: true,
    moduleName,
    log: result.log || [],
    result: result.result,
    time: result.time ?? null,
  };
}

async function handleMigrateCheck() {
  const status = await getMigrationStatus(requiredToken());
  return {
    ok: true,
    dbChanges: status?.db_changes || [],
    cards: (status?.db_changes || []).map((change) => changeCard(change)),
    ids: (status?.db_changes || []).map((change) => changeId(change)),
  };
}

// POST /api/migrate { ids: [...] } — the studio applies only what the user
// ticked, so the group flow of the CLI is not needed here.
async function handleMigrateApply(body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) {
    throw badRequest('Body must carry "ids": a non-empty list of change ids.');
  }
  const dry = body?.dry_run === true;
  if (dry) {
    await applyMigration(requiredToken(), { apply: ids, dry_run: true });
  } else {
    await applyMigration(requiredToken(), { apply: ids });
  }
  log('info', 'migrate', dry ? 'Dry-run check (studio).' : 'Changes applied (studio).', { count: ids.length });
  return { ok: true, applied: ids.length, dry_run: dry };
}

async function handleWebhookGet() {
  const wh = await getWebhook(requiredToken());
  return { ok: true, webhook: wh };
}

async function handleWebhookSync(body) {
  const wh = await syncWebhook(requiredToken(), { drop_pending: body?.drop_pending === true });
  log('info', 'webhook', 'Webhook synced (studio).', { drop_pending: body?.drop_pending === true, url: wh?.url });
  return { ok: true, webhook: wh };
}

function handleSchemaDiff() {
  if (!snapshotExists()) return { ok: true, hasSchema: true, touched: false, diff: null, note: 'No snapshot yet — use fetch.' };
  const remote = readSnapshotFile(SCHEMA_FILE);
  const local = existsDisk(SCHEMA_FILE) ? readDisk(SCHEMA_FILE) : null;
  if (remote == null && local == null) return { ok: true, hasSchema: false, touched: false, diff: null };
  const diff = computeDiff(remote ?? '', local ?? '', displayPath(SCHEMA_FILE));
  return { ok: true, hasSchema: true, touched: diff !== '', diff };
}

// The network settings the studio can change at runtime: which server to
// talk to and which proxy to use on the way there.
async function handleNetworkGet() {
  return { ok: true, config: networkConfig() };
}

async function handleNetworkSave(body) {
  const proxy = body?.proxy === undefined ? undefined : String(body.proxy ?? '').trim();
  const apiUrl = body?.apiUrl === undefined ? undefined : String(body.apiUrl ?? '').trim();
  const dohRaw = body?.doh === undefined ? undefined : body.doh === true || body.doh === 'true';
  const familyRaw = body?.family === undefined ? undefined : String(body.family ?? '').trim();
  const family =
    familyRaw === undefined
      ? undefined
      : familyRaw === '4'
        ? 4
        : familyRaw === '6'
          ? 6
          : familyRaw === '' || familyRaw === 'auto'
            ? 0
            : null;
  if (family === null) throw badRequest('The IP family must be auto, 4 or 6.');
  if (proxy !== undefined && proxy) {
    try {
      const parsed = new URL(proxy);
      const scheme = parsed.protocol.replace(':', '');
      if (!['http', 'https', 'socks5', 'socks'].includes(scheme) || !parsed.hostname || !parsed.port) {
        throw new Error('shape');
      }
    } catch {
      throw badRequest('That proxy address cannot be read. Use http://host:port or socks5://host:port.');
    }
  }
  if (apiUrl !== undefined && apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
    } catch {
      throw badRequest('That server address cannot be read. Use http://host:port or https://host.');
    }
  }
  const config = saveNetworkConfig({
    proxy,
    apiUrl,
    family: family === undefined ? undefined : family || null,
    doh: dohRaw === undefined ? undefined : dohRaw,
  });
  invalidateNetworkCache();
  log('info', 'network', 'Network settings changed from the studio.', {
    proxy: config.proxy || '(none)',
    apiUrl: config.apiUrl || '(default)',
  });
  return { ok: true, config };
}

async function handleNetworkTest(body) {
  const result = await diagnose({
    proxy: body?.proxy === undefined ? undefined : String(body.proxy ?? '').trim(),
    apiUrl: body?.apiUrl === undefined ? undefined : String(body.apiUrl ?? '').trim(),
    deep: body?.deep !== false,
    probe: body?.probe === true,
  });
  const started = Date.now();
  try {
    await requestPublic('GET', '/capabilities');
    result.steps.push({ id: 'reach', ok: true, text: 'the cloud answered' });
  } catch (err) {
    result.steps.push({ id: 'reach', ok: false, text: serverErrorText(err), hint: err?.hint || '' });
  }
  result.durationMs = Date.now() - started;
  return { ok: true, ...result };
}

function handleLogsGet(query) {
  const level = LEVELS[query?.get('level')] ? query.get('level') : undefined;
  const limit = Number(query?.get('limit')) || 100;
  const entries = readLogs({
    limit: Math.min(Math.max(limit, 1), 500),
    level: level || 'info',
    scope: query?.get('scope') || null,
  });
  return { ok: true, entries };
}

function handleLogsClear() {
  const cleared = clearLogs();
  log('info', 'logs', 'Journal cleared (studio).', { cleared });
  return { ok: true };
}
