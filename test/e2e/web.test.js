import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';

let cloud;
let token;
let proj;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
  proj = new Project(cloud, token, 'studio');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { console.log(2); return { echo: 1 }; }\n');
  proj.write('tgcloud.jsonc', JSON.stringify({ static: { source: 'dist', spa: true } }));
  proj.write('dist/index.html', '<h1>mini</h1>\n');
});

const api = async (childPort, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${childPort}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ui payload */ }
  return { status: res.status, text, json };
};

test('the studio serves the UI and a safe local API', async () => {
  const port = await freePort();
  const child = await startStudio(proj, port);
  try {
    const ui = await api(port, '/');
    assert.equal(ui.status, 200);
    assert.match(ui.text, /tgpilot studio/);

    const status = await api(port, '/api/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(typeof status.json.token.secret, 'undefined');
    assert.equal(status.json.token.masked, 'app100');

    const file = await api(port, '/api/file?path=tgcloud%2Fhandlers%2Fmessage.js');
    assert.equal(file.status, 200);
    assert.match(file.text, /message/);

    const tree = await api(port, '/api/tree');
    assert.equal(tree.status, 200, tree.text);
    assert.match(JSON.stringify(tree.json), /tgcloud/);

    const list = await api(port, '/api/list?path=tgcloud');
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.entries.some((e) => e.name === 'handlers' && e.dir));
    const root = await api(port, '/api/list');
    assert.equal(root.status, 200, root.text);
    const names = root.json.entries.map((e) => e.name);
    assert.ok(names.includes('tgcloud') && names.includes('tgcloud.jsonc'));

    const info = await api(port, '/api/project');
    assert.equal(info.status, 200, info.text);
    assert.ok(Array.isArray(info.json.runnable));
    assert.deepEqual(info.json.runnable, ['handlers', 'endpoints']);
    assert.deepEqual(info.json.static, { source: 'dist', spa: true });
    assert.ok(info.json.handlerTypes.length >= 20);
    assert.ok(info.json.handlerTypes.some((t) => t.type === 'callback_query'));

    const starter = await api(port, '/api/starter?kind=handlers&name=callback_query');
    assert.equal(starter.status, 200, starter.text);
    assert.match(starter.json.content, /callback_query, ctx/);
    const schemaStarter = await api(port, '/api/starter?kind=schema');
    assert.equal(schemaStarter.status, 200);
    assert.match(schemaStarter.json.content, /sdk\/db/);
    const badStarter = await api(port, '/api/starter?kind=handlers&name=..\%2Fevil');
    assert.equal(badStarter.status, 400);

    const missing = await api(port, '/api/list?path=tgcloud%2Flib');
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.json.entries, []);

    const goneFile = await api(port, '/api/file?path=tgcloud%2Flib%2Fnope.js');
    assert.equal(goneFile.status, 400);
    assert.match(goneFile.json.error, /File not found/);

    const forbidden = await api(port, '/api/file?path=.tgpilot%2Fstate.json');
    assert.equal(forbidden.status, 400);

    const escape = await api(port, '/api/file?path=..%2Fpackage.json');
    assert.equal(escape.status, 400);

    const created = await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/lib/scratch.js', content: '// scratch\n' } });
    assert.equal(created.status, 200, created.text);
    assert.ok(proj.read('tgcloud/lib/scratch.js'));

    const badWrite = await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/../evil.js', content: 'x' } });
    assert.equal(badWrite.status, 400);

    const run = await api(port, '/api/run', { method: 'POST', body: { module: 'message', args: { text: 'web-run' } } });
    assert.equal(run.status, 200, run.text);
    assert.match(JSON.stringify(run.json.result), /echo/);
    assert.ok(Array.isArray(run.json.log));

    const pushed = await api(port, '/api/push', { method: 'POST', body: {} });
    assert.equal(pushed.status, 200, pushed.text);
    assert.ok(pushed.json.changedCount > 0);

    const deployed = await api(port, '/api/push', { method: 'POST', body: { confirm: true } });
    assert.equal(deployed.status, 200, deployed.text);
    assert.equal(deployed.json.revision, 1);
    assert.equal(deployed.json.uploaded.count, 1);
    assert.match(deployed.json.staticUrl, /https:\/\/cdn\.mock\//);

    // A later push from the studio reports it is all done.
    const twice = await api(port, '/api/push', { method: 'POST', body: { confirm: true } });
    assert.equal(twice.status, 200, twice.text);
    assert.equal(twice.json.nothing, true);

    // Deleting a module through the studio lands with the same confirm gate.
    await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/handlers/extra.js', content: 'export default async function (chat_member, ctx) {}\n' } });
    assert.equal((await api(port, '/api/push', { method: 'POST', body: { confirm: true } })).json.revision, 2);
    await api(port, '/api/file', { method: 'DELETE', body: { path: 'tgcloud/handlers/extra.js' } });
    const delPreview = await api(port, '/api/push', { method: 'POST', body: {} });
    assert.ok(delPreview.json.deleted.includes('tgcloud/handlers/extra.js'), delPreview.text);
    assert.equal(delPreview.json.deletionsRequireConfirm, true);
    const delPush = await api(port, '/api/push', { method: 'POST', body: { confirm: true } });
    assert.equal(delPush.json.revision, 3, delPush.text);

    const webhook = await api(port, '/api/webhook');
    assert.equal(webhook.status, 200);
    assert.match(webhook.json.webhook.url, /https:\/\/t\.te\//);

    const logs = await api(port, '/api/logs');
    assert.equal(logs.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});

test('cloud outages answer in human language, not "fetch failed"', async () => {
  const port = await freePort();
  const offline = new Project(cloud, null, 'offline');
  offline.env.TGPILOT_API_URL = 'http://127.0.0.1:9/'; // nothing listens here
  offline.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(offline, port);
  try {
    // linking tolerates an unreachable cloud (saved as unverified)
    const link = await api(port, '/api/bot', { method: 'POST', body: { token: 'app77:zz' } });
    assert.equal(link.status, 200, link.text);
    assert.equal(link.json.token.unverified, true);

    // but a view that must talk to the cloud answers in human language
    const wh = await api(port, '/api/webhook');
    assert.equal(wh.status, 500, wh.text);
    assert.match(wh.json.error, /Could not reach the server at http:\/\/127\.0\.0\.1:9/);
    assert.doesNotMatch(wh.json.error, /fetch failed/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('linking a bot from the studio works and bad tokens are rejected', async () => {
  const port = await freePort();
  const child = await startStudio(proj, port);
  try {
    const bad = await api(port, '/api/bot', { method: 'POST', body: { token: 'definitely:wrong' } });
    assert.equal(bad.status, 400, bad.text);

    const good = await api(port, '/api/bot', { method: 'POST', body: { token } });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.json.token.masked, 'app100');
  } finally {
    child.kill('SIGTERM');
  }
});

test('web refuses to serve anything that is not a project', async () => {
  const bare = new Project(cloud, null, 'bare');
  const r = await bare.cli(['web']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /No project folder found/);
});
