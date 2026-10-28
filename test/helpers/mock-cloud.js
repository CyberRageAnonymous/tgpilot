import http from 'http';
import { createHash } from 'crypto';

// A stand-in for cloud.telegram.org covering the manage API surface tgpilot
// uses. One bot per token, everything in memory.

const TOKEN_FORMAT = /^app\d+:[A-Za-z0-9_-]+$/;
const md5 = (s) => createHash('md5').update(s).digest('hex');

export function createMockCloud() {
  const bots = new Map(); // appId → bot state
  const tokens = new Map(); // full token → appId

  function bot(token) {
    const appId = tokens.get(token);
    if (!appId) return null;
    return bots.get(appId);
  }

  let nextApp = 100;
  function mintToken(appId = `app${nextApp++}`) {
    const secret = 's3cr3t_' + appId;
    const token = `${appId}:${secret}`;
    tokens.set(token, appId);
    if (!bots.has(appId)) {
      bots.set(appId, {
        modules: new Map(),
        revision: 0,
        staticState: null, // {hash, manifest, config, blobs: Map}
        staticUrl: null,
        webhook: {
          url: `https://t.te/${appId}/hook`,
          allowed_updates: ['message', 'callback_query'],
          pending_update_count: 0,
          in_sync: true,
          expected: {
            url: `https://t.te/${appId}/hook`,
            allowed_updates: ['message', 'callback_query'],
          },
        },
        dbChanges: [],
        runs: [],
        botApiCalls: [],
        // The bot's own profile, the way Telegram would keep it.
        profile: {
          username: `mock_${appId}`,
          id: 1000000 + Number(String(appId).replace(/\D/g, '')) || 1,
          name: 'Mock Bot',
          description: '',
          short: '',
          menu: { type: 'default' },
        },
      });
    }
    return token;
  }

  // What `api.<method>()` does inside the isolate. The platform hands the
  // call to Telegram; here the same handful of methods is answered from the
  // bot's own profile, and anything else is refused the way Telegram would.
  function botApi(b, method, params = {}) {
    const p = b.profile;
    switch (method) {
      case 'getMe':
        return { id: p.id, is_bot: true, first_name: p.name, username: p.username };
      case 'getMyName':
        return { name: p.name };
      case 'setMyName':
        p.name = String(params.name ?? '');
        return { name: p.name };
      case 'getMyDescription':
        return { description: p.description };
      case 'setMyDescription':
        p.description = String(params.description ?? '');
        return { description: p.description };
      case 'getMyShortDescription':
        return { short_description: p.short };
      case 'setMyShortDescription':
        p.short = String(params.short_description ?? '');
        return { short_description: p.short };
      case 'getChatMenuButton':
        return { menu_button: p.menu };
      case 'setChatMenuButton': {
        const button = params.menu_button || {};
        if (!['default', 'commands', 'web_app'].includes(button.type)) {
          const bad = new Error('Bad Request: wrong menu button type');
          bad.code = 400;
          throw bad;
        }
        if (button.type === 'web_app' && !/^https:\/\//.test(String(button.web_app?.url || ''))) {
          const bad = new Error('Bad Request: menu button web app url must be https');
          bad.code = 400;
          throw bad;
        }
        p.menu = button;
        return true;
      }
      default: {
        const bad = new Error(`Bad Request: unknown method ${method}`);
        bad.code = 404;
        throw bad;
      }
    }
  }

  const send = (res, status, payload, ok = true) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true, result: payload } : payload));
  };
  const err = (res, status, description, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, description, error_code: status, ...extra }));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    const isBlob = /^\/(app\d+)\/manage\/static\/blob\//.test(p);
    // Clients that hang up early (a cancelled request) must not take the
    // whole test run down with an unhandled socket error.
    req.socket.on('error', () => {});

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body = {};
      if (!isBlob) {
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return err(res, 400, 'Bad JSON body');
        }
      }

      // Public capabilities, no auth.
      if (p === '/capabilities') {
        return send(res, 200, {
          project_schema_version: 1,
          min_cli_version: '0.0.1',
          directories: [
            { name: 'lib', nested: true, synced: true, runnable: false },
            { name: 'handlers', nested: false, synced: true, runnable: true },
            { name: 'endpoints', nested: false, synced: true, runnable: true },
          ],
          root_files: [{ name: 'schema.js', singleton: true }],
          scaffold: ['schema.js', 'lib/', 'handlers/', 'handlers/message.js'],
          templates: {
            'schema.js': '// server-issued schema starter\nexport const banner = null;\n',
            'handlers/message.js': '// server-issued handler starter\nexport default async function (msg, ctx) {\n  console.log("mock handler");\n}\n',
          },
        });
      }

      // manage/<...>/: token guarded.
      const m = p.match(/^\/(app\d+)\/manage(\/.*)$/);
      if (!m) return err(res, 404, 'Unknown route');
      const [, appId, apiPath] = m;

      const auth = req.headers.authorization || '';
      const provided = auth.replace(/^Bearer /, '');
      if (!TOKEN_FORMAT.test(provided) || tokens.get(provided) !== appId) {
        return err(res, 401, 'Invalid access token (rejecting from mock)');
      }
      const b = bots.get(appId);
      if (!b) return err(res, 404, 'No such app');

      const withBits = (out) => {
        const result = { ...out };
        if (b.dbChanges.length) result.db_changes = b.dbChanges;
        send(res, 200, result);
      };

      if (apiPath === '/get') {
        const canonical_modules = Object.fromEntries(b.modules);
        const result = { revision: b.revision, canonical_modules };
        if (b.staticState) {
          result.static = {
            url: b.staticUrl,
            hash: b.staticState.hash,
            manifest: b.staticState.manifest,
            config: b.staticState.config,
          };
        }
        return send(res, 200, result);
      }

      if (apiPath === '/deploy') {
        const { expected_revision, manifest, changed_sources } = body;
        // A module that carries the marker fails to compile, the way a real
        // cloud refuses broken code: with the file and the line.
        for (const [name, content] of Object.entries(changed_sources || {})) {
          if (typeof content === 'string' && content.includes('__COMPILE_ERROR__')) {
            const line = content.split('\n').findIndex((l) => l.includes('__COMPILE_ERROR__')) + 1;
            return err(res, 400, 'Compilation failed', {
              error_type: 'COMPILE_ERROR',
              parameters: {
                module: name,
                path: `tgcloud/${name}`,
                line,
                reason: 'Unexpected token in the module body',
              },
            });
          }
        }
        if (expected_revision != null && expected_revision !== b.revision && expected_revision !== 0) {
          return err(res, 409, 'Revision mismatch', {
            error_type: 'REVISION_MISMATCH',
            parameters: { current_revision: b.revision },
          });
        }
        if (manifest) {
          for (const name of [...b.modules.keys()]) {
            if (!manifest.includes(name)) b.modules.delete(name);
          }
          for (const [name, content] of Object.entries(changed_sources || {})) {
            b.modules.set(name, content);
          }
        }
        if ('static' in body) {
          const section = body.static;
          if (!section || section.hash === false) {
            b.staticState = null;
            b.staticUrl = null;
          } else if (b.staticState && section.hash === b.staticState.hash) {
            // already packaged
          } else {
            return err(res, 400, 'Static section references an unknown bundle', { error_type: 'STATIC_NOT_PREPARED' });
          }
        }
        b.revision++;
        b.dbChanges = schemaChanged(changed_sources, b);
        return withBits({
          revision: b.revision,
          canonical_modules: Object.fromEntries(b.modules),
          static: b.staticState
            ? { url: b.staticUrl, hash: b.staticState.hash, manifest: b.staticState.manifest, config: b.staticState.config }
            : undefined,
        });
      }

      if (apiPath === '/run') {
        const { module, sources, args, ctx } = body;
        const code = sources[module];
        if (code == null) return err(res, 404, `Unknown module ${module}`);
        const log = [{ _: 'log', t: 0.001, m: `ran ${module}` }];
        const fakeConsole = { log: (...l) => log.push({ _: 'log', t: 0.002, m: l.map(String).join(' ') }) };
        const api = new Proxy({}, {
          get(_target, method) {
            return async (params) => {
              b.botApiCalls.push({ module, method: String(method), params: params || {} });
              return botApi(b, String(method), params || {});
            };
          },
        });
        // The mock keeps the transpile step tiny: strip imports, turn the
        // default export into a binding, and run it.
        const transpiled = code
          .replace(/^import .*$/mg, '')
          .replace(/export\s+default\s+/mg, 'var main = ')
          .replace(/export\s+(const|let|var|function|class)\s+/mg, '$1 ')
          .replace(/export\s*\{[^}]*\}\s*;?/mg, '');
        try {
          const fnSrc = `return (async () => { ${transpiled}\n if (typeof main === 'undefined') throw new Error('module has no default export'); return main(sdkArgs, sdkCtx); })()`;
          const loader = new Function('console', 'sdkArgs', 'sdkCtx', 'api', fnSrc);
          const result = await loader(fakeConsole, args, ctx, api);
          b.runs.push({ module, args });
          return send(res, 200, { log, result, time: 0.05 });
        } catch (e) {
          const code = Number.isFinite(e?.code) ? e.code : 400;
          return err(res, code, String(e.message || e), { parameters: { log, time: 0.1 } });
        }
      }

      if (apiPath === '/migrate') {
        if (req.method === 'GET') {
          return send(res, 200, { db_changes: b.dbChanges });
        }
        const { apply, schema, dry_run } = body;
        if (dry_run) {
          return send(res, 200, { db_changes: schemaChanges(schema), dry_run: true });
        }
        b.dbChanges = [];
        return send(res, 200, { applied: (apply || []).length });
      }

      if (apiPath === '/webhook') {
        return send(res, 200, b.webhook);
      }

      if (apiPath === '/webhook/sync') {
        b.webhook.url = b.webhook.expected.url;
        b.webhook.allowed_updates = b.webhook.expected.allowed_updates;
        b.webhook.in_sync = true;
        if (body.drop_pending_updates) b.webhook.pending_update_count = 0;
        if (body.allowed_updates) b.webhook.allowed_updates = body.allowed_updates;
        return send(res, 200, b.webhook);
      }

      if (apiPath === '/static/prepare') {
        const { manifest, config } = body;
        // Bundle hash is the content fingerprint, so identical content
        // prepared twice lands on the same bundle.
        const sortedManifest = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
        const bundle = md5(JSON.stringify({ config, manifest: sortedManifest }));
        const wanted = [...new Set(Object.keys(sortedManifest).map((k) => sortedManifest[k].hash))];
        const missing = wanted.filter((hash) => !(b.staticState && b.staticState.blobs && b.staticState.blobs.has(hash)));
        if (missing.length === 0) {
          b.staticState = { hash: bundle, blobs: b.staticState.blobs, manifest: sortedManifest, config };
          b.staticUrl = `https://cdn.mock/${appId}/${bundle}/`;
          return send(res, 200, { hash: bundle, missing: [], expires_at: new Date(Date.now() + 3e5).toISOString() });
        }
        b.$$prepare = { hash: bundle, manifest: sortedManifest, config, pending: missing };
        return send(res, 200, { hash: bundle, missing, expires_at: new Date(Date.now() + 3e5).toISOString() });
      }

      const blobMatch = apiPath.match(/^\/static\/blob\/([0-9a-f]{32})$/);
      if (blobMatch && req.method === 'PUT') {
        const hash = blobMatch[1];
        const prep = b.$$prepare;
        if (!prep || !prep.pending.includes(hash)) {
          return err(res, 404, 'Unknown blob', { error_type: 'STATIC_NOT_PREPARED' });
        }
        if (!b.staticState) b.staticState = { hash: null, blobs: new Map() };
        b.staticState.blobs.set(hash, raw);
        prep.pending = prep.pending.filter((h) => h !== hash);
        if (prep.pending.length === 0) {
          b.staticState.hash = prep.hash;
          b.staticState.manifest = prep.manifest;
          b.staticState.config = prep.config;
          b.staticUrl = `https://cdn.mock/${appId}/${prep.hash}/`;
        }
        return send(res, 200, { stored: hash });
      }

      return err(res, 404, 'Unknown manage route');
    });
  });

  // A client that hangs up early (a cancelled request) must not take the
  // whole test run down with an unhandled socket error.
  server.on('connection', (socket) => socket.on('error', () => {}));

  return { server, mintToken, bots, tokens };
}

// Fake DB diffing: the first push with schema.js yields a safe change, later
// pushes surface a warning change to also exercise that flow.
function schemaChanged(changedSources, b) {
  if (!changedSources || !('schema' in changedSources)) return b.dbChanges;
  if (b.dbChanges.length) return b.dbChanges;
  if (b.revision <= 1) {
    return [
      {
        kind: 'create_column',
        table: 'messages',
        column: 'text',
        status: 'good',
        sql: 'ALTER TABLE messages ADD COLUMN text TEXT;',
        reason: 'in schema.js',
      },
    ];
  }
  return [
    {
      kind: 'drop_column',
      table: 'messages',
      column: 'old_flag',
      status: 'warning',
      sql: 'ALTER TABLE messages DROP COLUMN old_flag;',
      warning: 'Data in this column is deleted.',
    },
  ];
}

// schema probe used by migrate dry_run
function schemaChanges(schema) {
  return [
    {
      kind: 'create_column',
      table: 'm',
      column: 'z',
      status: 'good',
      sql: 'ALTER TABLE m ADD COLUMN z TEXT;',
    },
  ];
}
