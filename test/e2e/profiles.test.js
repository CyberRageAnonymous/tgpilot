import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';

let cloud;
let tokenA;
let tokenB;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
  tokenA = cloud.mintToken();
  tokenB = cloud.mintToken();
});

const api = async (port, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
};

test('two bots can live in one folder and be switched', async () => {
  const proj = new Project(cloud, null, 'profiles');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');

  const first = await proj.cli(['login', tokenA, '--profile', 'staging']);
  assert.equal(first.code, 0, first.out);
  const second = await proj.cli(['login', tokenB, '--profile', 'production']);
  assert.equal(second.code, 0, second.out);

  const list = await proj.cli(['profiles']);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /staging/);
  assert.match(list.out, /production/);

  // Linking a second bot does not switch to it: the folder stays with the
  // bot that is active.
  const active = await proj.cli(['profiles']);
  assert.match(active.out, /\*\s+staging/);

  const switched = await proj.cli(['profiles', '--use', 'staging']);
  assert.equal(switched.code, 0, switched.out);
  const after = await proj.cli(['profiles']);
  assert.match(after.out, /\*\s+staging/);

  // A profile that does not exist is refused.
  const missing = await proj.cli(['profiles', '--use', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no profile called/);
});

test('the studio can link, switch and remove a bot', async () => {
  const port = await freePort();
  const proj = new Project(cloud, null, 'profiles-studio');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const empty = await api(port, '/api/profiles');
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json.profiles, []);

    const linked = await api(port, '/api/profiles', { method: 'POST', body: { token: tokenA, name: 'staging' } });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.json.profiles.length, 1);
    assert.equal(linked.json.profiles[0].name, 'staging');
    assert.equal(linked.json.profiles[0].active, true);

    const second = await api(port, '/api/profiles', { method: 'POST', body: { token: tokenB, name: 'production' } });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.profiles.length, 2);
    assert.equal(second.json.active, 'staging', 'linking does not switch');

    const used = await api(port, '/api/profiles/use', { method: 'POST', body: { name: 'staging' } });
    assert.equal(used.status, 200, used.text);
    assert.equal(used.json.active, 'staging');

    const bad = await api(port, '/api/profiles/use', { method: 'POST', body: { name: 'ghost' } });
    assert.equal(bad.status, 400);

    const removed = await api(port, '/api/profiles', { method: 'DELETE', body: { name: 'production' } });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.profiles.length, 1);
  } finally {
    child.kill('SIGTERM');
  }
});

test('each bot keeps its own deployed files', async () => {
  // Two bots, two different sets of files: switching has to show the right
  // ones, not the ones of the bot that was active before.
  const proj = new Project(cloud, null, 'per-profile');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');

  await proj.cli(['login', tokenA, '--profile', 'staging']);
  await proj.cli(['login', tokenB, '--profile', 'production']);

  // Give the two bots different code.
  const bots = cloud.bots;
  const list = [...bots.values()];
  list[0].modules.set('handlers/only_staging', 'export default async function (a, ctx) { return "staging"; }\n');
  list[0].revision += 1;
  list[1].modules.set('handlers/only_production', 'export default async function (a, ctx) { return "production"; }\n');
  list[1].revision += 1;

  await proj.cli(['profiles', '--use', 'staging']);
  const staging = await proj.cli(['pull']);
  assert.equal(staging.code, 0, staging.out);
  assert.ok(proj.exists('tgcloud/handlers/only_staging.js'), 'the staging bot brought its file');
  assert.equal(proj.exists('tgcloud/handlers/only_production.js'), false, 'not the other bot\'s file');

  await proj.cli(['profiles', '--use', 'production']);
  const production = await proj.cli(['pull']);
  assert.equal(production.code, 0, production.out);
  assert.ok(proj.exists('tgcloud/handlers/only_production.js'), 'the production bot brought its file');
});

test('switching bots takes the files of the other bot with them', async () => {
  // The folder belongs to the bot that is active. Switching to another bot
  // brings that bot's files in, and the files of the bot you left are put
  // away — they were never yours, they were that bot's.
  const proj = new Project(cloud, null, 'switch-files');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');

  await proj.cli(['login', tokenA, '--profile', 'staging']);
  await proj.cli(['login', tokenB, '--profile', 'production']);
  assert.ok(proj.exists('tgcloud/handlers/message.js'), 'linking a second bot does not empty the folder');
  assert.match((await proj.cli(['profiles'])).out, /\*\s+staging/, 'the first bot stays active');

  // A file that belongs to the staging bot.
  proj.write('tgcloud/handlers/staging_only.js', 'export default async function (a, ctx) { return "staging"; }\n');
  await proj.cli(['profiles', '--use', 'production']);
  assert.equal(
    proj.exists('tgcloud/handlers/staging_only.js'),
    false,
    'the file of the other bot is not in the folder any more'
  );

  await proj.cli(['profiles', '--use', 'staging']);
  assert.ok(proj.exists('tgcloud/handlers/staging_only.js'), 'and it comes back with its bot');
});

test('unlinking a bot takes its files out of the folder', async () => {
  const proj = new Project(cloud, null, 'unlink-files');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  await proj.cli(['login', tokenA, '--profile', 'staging']);
  proj.write('tgcloud/handlers/staging_only.js', 'export default async function (a, ctx) { return "staging"; }\n');

  await proj.cli(['logout', '--profile', 'staging']);
  assert.equal(
    proj.exists('tgcloud/handlers/staging_only.js'),
    false,
    'the files of the bot that was unlinked leave the folder'
  );
});

test('the old single token still works', async () => {
  // A project that was linked before the profiles existed keeps working.
  const proj = new Project(cloud, null, 'legacy');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join(proj.dir, '.tgpilot'), { recursive: true });
  fs.writeFileSync(path.join(proj.dir, '.tgpilot', 'credentials'), JSON.stringify({ token: tokenA }));

  const list = await proj.cli(['profiles']);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /default/);
  assert.match(list.out, /app100/);
});

test('without a bot the studio writes nothing', async () => {
  const port = await freePort();
  const proj = new Project(cloud, null, 'no-bot');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  // No token at all: nothing is linked.
  const child = await startStudio(proj, port);
  try {
    const written = await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/lib/x.js', content: 'x' } });
    assert.equal(written.status, 400, written.text);
    assert.match(written.json.error, /Link a bot first/);

    const removed = await api(port, '/api/file', { method: 'DELETE', body: { path: 'tgcloud/handlers/message.js' } });
    assert.equal(removed.status, 400, removed.text);

    // And the files of a bot that was here before are not shown either.
    const tree = await api(port, '/api/tree');
    assert.equal(tree.status, 200, tree.text);
    assert.deepEqual(tree.json.tree, [], 'no files without a bot');
    const list = await api(port, '/api/list?path=tgcloud');
    assert.deepEqual(list.json.entries, []);
  } finally {
    child.kill('SIGTERM');
  }
});

test('every bot has its own backups', async () => {
  const port = await freePort();
  const proj = new Project(cloud, null, 'backups-per-bot');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    await api(port, '/api/profiles', { method: 'POST', body: { token: tokenA, name: 'staging' } });
    await api(port, '/api/profiles', { method: 'POST', body: { token: tokenB, name: 'production' } });

    const staging = await api(port, '/api/backups', { method: 'POST', body: { label: 'staging copy' } });
    assert.equal(staging.status, 200, staging.text);
    assert.equal(staging.json.backups.length, 1);

    await api(port, '/api/profiles/use', { method: 'POST', body: { name: 'production' } });
    const production = await api(port, '/api/backups');
    assert.equal(production.status, 200, production.text);
    assert.deepEqual(production.json.backups, [], 'the other bot has no backups');

    await api(port, '/api/profiles/use', { method: 'POST', body: { name: 'staging' } });
    const back = await api(port, '/api/backups');
    assert.equal(back.json.backups.length, 1, 'its own backup is there again');
  } finally {
    child.kill('SIGTERM');
  }
});

test('unlinking the last bot empties the folder', async () => {
  const port = await freePort();
  const proj = new Project(cloud, null, 'unlink-last');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    await api(port, '/api/profiles', { method: 'POST', body: { token: tokenA, name: 'staging' } });
    assert.equal(proj.exists('tgcloud/handlers/message.js'), true);

    await api(port, '/api/profiles', { method: 'DELETE', body: { name: 'staging' } });
    assert.equal(proj.exists('tgcloud/handlers/message.js'), false, 'the files leave with the bot');
    const backups = await api(port, '/api/backups');
    assert.deepEqual(backups.json.backups, [], 'and no backups are left to show');
  } finally {
    child.kill('SIGTERM');
  }
});
