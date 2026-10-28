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
    assert.doesNotMatch(wh.json.error, /fetch failed/);  } finally {
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

test('the studio can set a proxy and test the connection at runtime', async () => {
  const port = await freePort();
  const child = await startStudio(proj, port);
  try {
    const before = await api(port, '/api/network');
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.config.proxy, '');

    const bad = await api(port, '/api/network', { method: 'POST', body: { proxy: 'not a proxy' } });
    assert.equal(bad.status, 400, bad.text);

    const saved = await api(port, '/api/network', { method: 'POST', body: { proxy: 'socks5://127.0.0.1:10809' } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.config.proxy, 'socks5://127.0.0.1:10809');
    assert.equal(saved.json.config.proxySource, 'project');

    const test = await api(port, '/api/network/test', { method: 'POST', body: {} });
    assert.equal(test.status, 200, test.text);
    const steps = test.json.steps.map((s) => s.id);
    assert.ok(steps.includes('proxy'), steps.join(','));
    assert.ok(steps.includes('dns'), steps.join(','));
    assert.ok(steps.includes('reach'), steps.join(','));
    const proxyStep = test.json.steps.find((s) => s.id === 'proxy');
    assert.equal(proxyStep.ok, false);
    assert.match(proxyStep.text, /nothing is listening/);

    // the saved proxy is the one the studio now uses
    const hook = await api(port, '/api/webhook');
    assert.equal(hook.status, 500, hook.text);
    assert.match(hook.json.error, /socks5:\/\/127\.0\.0\.1:10809/);

    // and it can be cleared again
    const cleared = await api(port, '/api/network', { method: 'POST', body: { proxy: '' } });
    assert.equal(cleared.json.config.proxy, '');
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

test('a cloud failure comes back as a report with the file that failed', async () => {
  const port = await freePort();
  // A fresh bot: the safety check refuses to overwrite a bot this folder
  // has never synced with.
  const broken = new Project(cloud, cloud.mintToken(), 'broken');
  broken.write(
    'tgcloud/handlers/message.js',
    'export default async function (message, ctx) {\n  const x = __COMPILE_ERROR__;\n  return x;\n}\n'
  );
  const child = await startStudio(broken, port);
  try {
    const res = await api(port, '/api/push', { method: 'POST', body: { confirm: true } });
    assert.equal(res.status, 400, res.text);
    assert.match(res.json.error, /Compilation failed/);
    assert.ok(res.json.details, 'the answer carries details');
    assert.equal(res.json.details.file, 'tgcloud/handlers/message.js');
    assert.equal(res.json.details.line, 2);
    assert.match(res.json.details.reason, /Unexpected token/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('without a bot the studio shows nothing and writes nothing', async () => {
  const port = await freePort();
  const bare = new Project(cloud, null, 'bare-bot');
  bare.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(bare, port);
  try {
    // Nothing is linked: the folder belongs to nobody.
    const tree = await api(port, '/api/tree');
    assert.equal(tree.status, 200, tree.text);
    assert.deepEqual(tree.json.tree, [], 'no files are shown');

    const list = await api(port, '/api/list?path=tgcloud');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.entries, []);

    const written = await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/lib/x.js', content: 'x' } });
    assert.equal(written.status, 400, written.text);
    assert.match(written.json.error, /Link a bot first/);

    const removed = await api(port, '/api/file', { method: 'DELETE', body: { path: 'tgcloud/handlers/message.js' } });
    assert.equal(removed.status, 400, removed.text);
  } finally {
    child.kill('SIGTERM');
  }
});

test('linking a bot brings its files into the folder', async () => {
  const port = await freePort();
  const token = cloud.mintToken();
  const fresh = new Project(cloud, token, 'link-files');
  fresh.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');

  const child = await startStudio(fresh, port);
  try {
    // The bot of this token already runs a module; the folder knows nothing
    // about it.
    const bot = cloud.bots.get(token.split(':')[0]);
    bot.modules.set('handlers/callback_query', 'export default async function (cb, ctx) { return 2; }\n');

    const linked = await api(port, '/api/bot', { method: 'POST', body: { token } });
    assert.equal(linked.status, 200, linked.text);
    assert.ok(linked.json.brought >= 1, 'the studio reports the files it brought in');

    // And the file is really in the folder now.
    const list2 = await api(port, '/api/list?path=tgcloud/handlers');
    assert.equal(list2.status, 200, list2.text);
    const names = list2.json.entries.map((e) => e.name);
    assert.ok(names.includes('callback_query.js'), names.join(','));
  } finally {
    child.kill('SIGTERM');
  }
});

test('the studio reads and writes the bot profile and its menu button', async () => {
  const port = await freePort();
  const child = await startStudio(proj, port);
  try {
    const before = await api(port, '/api/bot/profile');
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.profile.name, 'Mock Bot');
    assert.equal(before.json.profile.menu.type, 'default');

    const saved = await api(port, '/api/bot/profile', {
      method: 'POST',
      body: { name: 'Studio Bot', short: 'Short.', description: 'Long.' },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json.saved, { name: 'Studio Bot', short: 'Short.', description: 'Long.' });

    const after = await api(port, '/api/bot/profile');
    assert.equal(after.json.profile.name, 'Studio Bot');
    assert.equal(after.json.profile.short, 'Short.');
    assert.equal(after.json.profile.description, 'Long.');

    const menu = await api(port, '/api/bot/menu', {
      method: 'POST',
      body: { type: 'web_app', text: 'Open', url: 'https://example.com/app' },
    });
    assert.equal(menu.status, 200, menu.text);

    const withMenu = await api(port, '/api/bot/profile');
    assert.equal(withMenu.json.profile.menu.type, 'web_app');
    assert.equal(withMenu.json.profile.menu.text, 'Open');
    assert.equal(withMenu.json.profile.menu.web_app.url, 'https://example.com/app');

    const badUrl = await api(port, '/api/bot/menu', {
      method: 'POST',
      body: { type: 'web_app', url: 'http://example.com/app' },
    });
    assert.equal(badUrl.status, 400, badUrl.text);
    assert.match(badUrl.json.error, /https/);

    const empty = await api(port, '/api/bot/profile', { method: 'POST', body: { name: '   ' } });
    assert.equal(empty.status, 400, empty.text);
    assert.match(empty.json.error, /cannot be empty/);

    // A description is allowed to be cleared; the name is not.
    const cleared = await api(port, '/api/bot/profile', { method: 'POST', body: { short: '' } });
    assert.equal(cleared.status, 200, cleared.text);
    const afterClear = await api(port, '/api/bot/profile');
    assert.equal(afterClear.json.profile.short, '');
  } finally {
    child.kill('SIGTERM');
  }
});
